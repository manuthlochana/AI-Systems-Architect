import { and, asc, eq, isNull, lt, or, sql } from "drizzle-orm";
import {
  conversationMessagesTable,
  conversationsTable,
  db,
  webhookEventsTable,
} from "@workspace/db";
import { generateStudentReply } from "./ai-agent";
import { logger } from "./logger";
import { normalizePhoneNumber } from "./spreadsheet";
import { isYCloudConfigured, sendYCloudText } from "./ycloud";

const MAX_ATTEMPTS = 5;
const RETRY_DELAY_MS = 15_000;
const PROCESSING_LEASE_MS = 3 * 60_000;
const WHATSAPP_SESSION_MS = 24 * 60 * 60_000;
const HUMAN_HANDOFF_MS = 48 * 60 * 60_000;

type WebhookEvent = typeof webhookEventsTable.$inferSelect;
type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function getInboundMessage(payload: JsonObject) {
  const message = asObject(payload.whatsappInboundMessage);
  if (!message) return undefined;
  const text = asObject(message.text);
  const profile = asObject(message.customerProfile);
  const phoneValue = typeof message.from === "string" ? message.from : "";
  const providerMessageId =
    typeof message.wamid === "string"
      ? message.wamid
      : typeof message.id === "string"
        ? message.id
        : "";
  const body = typeof text?.body === "string" ? text.body.trim() : "";
  const name = typeof profile?.name === "string" ? profile.name.slice(0, 120) : null;
  const type = typeof message.type === "string" ? message.type : "unknown";
  return { phoneValue, providerMessageId, body, name, type };
}

async function saveOutboundAndSend(
  event: WebhookEvent,
  phoneNumber: string,
  body: string,
): Promise<void> {
  const externalId = `almedia_${event.providerEventId}`.slice(0, 120);
  let [outbound] = await db
    .select()
    .from(conversationMessagesTable)
    .where(eq(conversationMessagesTable.externalId, externalId))
    .limit(1);

  if (outbound?.deliveryStatus === "sent") return;
  if (!outbound) {
    const [created] = await db
      .insert(conversationMessagesTable)
      .values({
        phoneNumber,
        direction: "outbound",
        body,
        externalId,
        deliveryStatus: "pending",
      })
      .onConflictDoNothing()
      .returning();
    outbound = created;
    if (!outbound) {
      [outbound] = await db
        .select()
        .from(conversationMessagesTable)
        .where(eq(conversationMessagesTable.externalId, externalId))
        .limit(1);
    }
  }
  if (!outbound || outbound.deliveryStatus === "sent") return;

  try {
    const providerMessageId = await sendYCloudText(
      phoneNumber,
      outbound.body,
      externalId,
    );
    await db
      .update(conversationMessagesTable)
      .set({
        deliveryStatus: "sent",
        providerMessageId: providerMessageId ?? undefined,
      })
      .where(eq(conversationMessagesTable.id, outbound.id));
  } catch (error) {
    await db
      .update(conversationMessagesTable)
      .set({ deliveryStatus: "failed" })
      .where(eq(conversationMessagesTable.id, outbound.id));
    throw error;
  }
}

async function processInbound(event: WebhookEvent): Promise<void> {
  if (event.eventType !== "whatsapp.inbound_message.received") return;
  const inbound = getInboundMessage(event.payload);
  if (!inbound?.providerMessageId || !inbound.phoneValue) return;

  let phoneNumber: string;
  try {
    phoneNumber = normalizePhoneNumber(inbound.phoneValue);
  } catch {
    logger.warn({ eventId: event.providerEventId }, "Ignored invalid WhatsApp sender number");
    return;
  }

  const [existingConversation] = await db
    .select()
    .from(conversationsTable)
    .where(eq(conversationsTable.phoneNumber, phoneNumber))
    .limit(1);
  const staleHumanHandoff =
    existingConversation?.mode === "human" &&
    event.receivedAt.getTime() - existingConversation.lastMessageAt.getTime() >= HUMAN_HANDOFF_MS;
  const mode = staleHumanHandoff ? "bot" : existingConversation?.mode ?? "bot";
  const messageBody = inbound.body || `[WhatsApp ${inbound.type} message]`;

  await db
    .insert(conversationsTable)
    .values({
      phoneNumber,
      studentName: inbound.name,
      mode,
      lastMessageAt: event.receivedAt,
    })
    .onConflictDoUpdate({
      target: conversationsTable.phoneNumber,
      set: {
        ...(inbound.name ? { studentName: inbound.name } : {}),
        mode,
        lastMessageAt: sql`greatest(${conversationsTable.lastMessageAt}, ${event.receivedAt})`,
      },
    });

  const [savedInbound] = await db
    .insert(conversationMessagesTable)
    .values({
      phoneNumber,
      direction: "inbound",
      body: messageBody,
      providerMessageId: inbound.providerMessageId,
      deliveryStatus: "received",
    })
    .onConflictDoNothing()
    .returning({ id: conversationMessagesTable.id });

  if (!savedInbound) return;
  if (mode === "human" || !inbound.body) return;

  const age = Date.now() - event.receivedAt.getTime();
  if (age > WHATSAPP_SESSION_MS) {
    logger.info({ eventId: event.providerEventId }, "Skipped reply outside the WhatsApp service window");
    return;
  }

  const externalId = `almedia_${event.providerEventId}`.slice(0, 120);
  const existingOutbound = await db
    .select()
    .from(conversationMessagesTable)
    .where(eq(conversationMessagesTable.externalId, externalId))
    .limit(1);

  if (existingOutbound[0]) {
    await saveOutboundAndSend(event, phoneNumber, existingOutbound[0].body);
    return;
  }

  const [conversation] = await db
    .select()
    .from(conversationsTable)
    .where(eq(conversationsTable.phoneNumber, phoneNumber))
    .limit(1);
  const batch = conversation?.batch ?? "unknown";
  const reply = await generateStudentReply({
    phoneNumber,
    studentName: conversation?.studentName ?? inbound.name,
    batch,
    providerMessageId: inbound.providerMessageId,
  });
  await db
    .update(conversationsTable)
    .set({ lastIntent: reply.lastIntent })
    .where(eq(conversationsTable.phoneNumber, phoneNumber));

  await saveOutboundAndSend(event, phoneNumber, reply.text);
}

async function claimNextEvent(): Promise<WebhookEvent | undefined> {
  const now = new Date();
  const retryBefore = new Date(now.getTime() - RETRY_DELAY_MS);
  const staleBefore = new Date(now.getTime() - PROCESSING_LEASE_MS);
  const duePending = and(
    eq(webhookEventsTable.status, "pending"),
    or(
      isNull(webhookEventsTable.processingAt),
      lt(webhookEventsTable.processingAt, retryBefore),
    ),
  );
  const abandonedProcessing = and(
    eq(webhookEventsTable.status, "processing"),
    or(
      isNull(webhookEventsTable.processingAt),
      lt(webhookEventsTable.processingAt, staleBefore),
    ),
  );
  const [candidate] = await db
    .select()
    .from(webhookEventsTable)
    .where(or(duePending, abandonedProcessing))
    .orderBy(asc(webhookEventsTable.receivedAt))
    .limit(1);
  if (!candidate) return undefined;

  const [claimed] = await db
    .update(webhookEventsTable)
    .set({
      status: "processing",
      processingAt: now,
      attempts: sql`${webhookEventsTable.attempts} + 1`,
    })
    .where(
      and(
        eq(webhookEventsTable.providerEventId, candidate.providerEventId),
        or(duePending, abandonedProcessing),
      ),
    )
    .returning();
  return claimed;
}

async function processOneEvent(): Promise<boolean> {
  const event = await claimNextEvent();
  if (!event) return false;
  try {
    await processInbound(event);
    await db
      .update(webhookEventsTable)
      .set({ status: "processed", processingAt: null, lastError: null })
      .where(eq(webhookEventsTable.providerEventId, event.providerEventId));
  } catch {
    const terminal = event.attempts >= MAX_ATTEMPTS;
    await db
      .update(webhookEventsTable)
      .set({
        status: terminal ? "failed" : "pending",
        processingAt: new Date(),
        lastError: terminal
          ? "Processing failed after the retry limit."
          : "Processing failed; scheduled for retry.",
      })
      .where(eq(webhookEventsTable.providerEventId, event.providerEventId));
    logger.error(
      { eventId: event.providerEventId, attempt: event.attempts, terminal },
      "WhatsApp webhook processing failed",
    );
  }
  return true;
}

let running = false;

export function startWebhookWorker(): void {
  const poll = async () => {
    if (running || !process.env.GEMINI_API_KEY || !isYCloudConfigured()) return;
    running = true;
    try {
      for (let processed = 0; processed < 10; processed += 1) {
        if (!(await processOneEvent())) break;
      }
    } catch {
      logger.error("WhatsApp worker could not query the event queue");
    } finally {
      running = false;
    }
  };

  void poll();
  setInterval(() => void poll(), 5_000);
}
