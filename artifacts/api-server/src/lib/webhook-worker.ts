import { and, asc, desc, eq, gte, isNull, lt, or, sql } from "drizzle-orm";
import {
  conversationMessagesTable,
  conversationsTable,
  db,
  webhookEventsTable,
} from "@workspace/db";
import { generateStudentReply } from "./ai-agent";
import { logger } from "./logger";
import { normalizePhoneNumber, toPhoneKey } from "./spreadsheet";
import { isGroupChatEvent, parseInboundMessage } from "./whatsapp-event";
import { isYCloudConfigured, sendYCloudText } from "./ycloud";

const MAX_ATTEMPTS = 5;
const RETRY_DELAY_MS = 15_000;
const PROCESSING_LEASE_MS = 3 * 60_000;
const WHATSAPP_SESSION_MS = 24 * 60 * 60_000;
const HUMAN_HANDOFF_MS = 48 * 60 * 60 * 1000;

/** Rapid-fire messages inside this window are merged into one Gemini prompt. */
const DEBOUNCE_WINDOW_MS = 7_000;
const DEBOUNCE_MAX_RETRIES = 2;
const DEBOUNCE_RETRY_DELAY_MS = 15_000;

const DAILY_MESSAGE_LIMIT = 25;
const COLOMBO_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const DAILY_LIMIT_MESSAGE =
  "ඔබ අද දිනට හිමි පණිවිඩ සීමාව ඉක්මවා ඇත. හදිසි අවශ්‍යතාවයක් සඳහා කාර්යාලය අමතන්න: 071 016 1699.";

type WebhookEvent = typeof webhookEventsTable.$inferSelect;

/** Start of the calendar day (Asia/Colombo) containing `at`. */
function startOfColomboDay(at: Date): Date {
  const local = at.getTime() + COLOMBO_OFFSET_MS;
  const dayStartLocal = Math.floor(local / 86_400_000) * 86_400_000;
  return new Date(dayStartLocal - COLOMBO_OFFSET_MS);
}

async function saveOutboundAndSend(
  externalId: string,
  phoneNumber: string,
  body: string,
): Promise<void> {
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

interface PendingDebounce {
  timer: NodeJS.Timeout;
  phoneNumber: string;
  studentName: string | null;
  providerMessageId: string;
  /** DB id of the newest inbound message in this burst (for idempotent reply ids). */
  lastMessageDbId: number;
  retries: number;
}

/** In-memory debounce queue keyed by the 9-digit phone key. */
const debounceQueue = new Map<string, PendingDebounce>();

function scheduleDebouncedReply(
  key: string,
  entry: Omit<PendingDebounce, "timer" | "retries">,
  delayMs = DEBOUNCE_WINDOW_MS,
  retries = 0,
): void {
  const existing = debounceQueue.get(key);
  if (existing) clearTimeout(existing.timer);
  const timer = setTimeout(() => void flushDebounced(key), delayMs);
  debounceQueue.set(key, { ...entry, timer, retries });
}

async function flushDebounced(key: string): Promise<void> {
  const entry = debounceQueue.get(key);
  if (!entry) return;
  debounceQueue.delete(key);

  try {
    const [conversation] = await db
      .select()
      .from(conversationsTable)
      .where(eq(conversationsTable.phoneNumber, entry.phoneNumber))
      .limit(1);
    // Staff may have taken over while the debounce window was open.
    if (conversation?.mode === "human") return;

    // All inbound texts in the burst are in the DB; generateStudentReply merges
    // consecutive student messages into a single consolidated prompt.
    const reply = await generateStudentReply({
      phoneNumber: entry.phoneNumber,
      studentName: conversation?.studentName ?? entry.studentName,
      batch: conversation?.batch ?? "unknown",
      providerMessageId: entry.providerMessageId,
    });
    await db
      .update(conversationsTable)
      .set({ lastIntent: reply.lastIntent })
      .where(eq(conversationsTable.phoneNumber, entry.phoneNumber));

    await saveOutboundAndSend(
      `almedia_d${key}_${entry.lastMessageDbId}`.slice(0, 120),
      entry.phoneNumber,
      reply.text,
    );
  } catch (error) {
    // A newer burst may already be queued for this number; it will cover these messages.
    if (debounceQueue.has(key)) return;
    const errDetail = error instanceof Error ? error.message : String(error);
    if (entry.retries < DEBOUNCE_MAX_RETRIES) {
      logger.warn(
        { retry: entry.retries + 1, error: errDetail, phone: entry.phoneNumber },
        "Debounced reply failed; retrying",
      );
      scheduleDebouncedReply(key, entry, DEBOUNCE_RETRY_DELAY_MS, entry.retries + 1);
    } else {
      logger.error(
        { err: errDetail, phone: entry.phoneNumber },
        "Debounced reply failed permanently",
      );
    }
  }
}

async function processInbound(event: WebhookEvent): Promise<void> {
  if (event.eventType !== "whatsapp.inbound_message.received") return;

  // Strictly 1-on-1 chats: discard anything that originates from a WhatsApp group.
  if (isGroupChatEvent(event.payload)) {
    logger.info({ eventId: event.providerEventId }, "Discarded WhatsApp group event");
    return;
  }

  const inbound = parseInboundMessage(event.payload);
  if (!inbound?.providerMessageId || !inbound.phoneValue) return;

  let phoneNumber: string;
  let phoneKey: string;
  try {
    phoneNumber = normalizePhoneNumber(inbound.phoneValue);
    phoneKey = toPhoneKey(phoneNumber);
  } catch {
    logger.warn({ eventId: event.providerEventId }, "Ignored invalid WhatsApp sender number");
    return;
  }

  const [existingConversation] = await db
    .select()
    .from(conversationsTable)
    .where(eq(conversationsTable.phoneNumber, phoneNumber))
    .limit(1);

  // 48-hour auto-reset: a stale human handoff returns to the bot.
  const staleHumanHandoff =
    existingConversation?.mode === "human" &&
    Date.now() - new Date(existingConversation.lastMessageAt).getTime() > HUMAN_HANDOFF_MS;
  if (staleHumanHandoff) {
    await db
      .update(conversationsTable)
      .set({ mode: "bot" })
      .where(eq(conversationsTable.phoneNumber, phoneNumber));
    logger.info({ eventId: event.providerEventId }, "Human handoff expired after 48h; reset to bot");
  }
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

  // Daily cap (calendar day, Asia/Colombo) per phone number, counted across number formats.
  const [{ count: todayCount }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(conversationMessagesTable)
    .where(
      and(
        sql`right(regexp_replace(${conversationMessagesTable.phoneNumber}, '\\D', '', 'g'), 9) = ${phoneKey}`,
        eq(conversationMessagesTable.direction, "inbound"),
        gte(conversationMessagesTable.createdAt, startOfColomboDay(event.receivedAt)),
      ),
    );
  if (todayCount > DAILY_MESSAGE_LIMIT) {
    // Bypass the LLM entirely. Notify once (on the first excess message) to avoid spamming.
    const pending = debounceQueue.get(phoneKey);
    if (pending) {
      clearTimeout(pending.timer);
      debounceQueue.delete(phoneKey);
    }
    if (todayCount === DAILY_MESSAGE_LIMIT + 1) {
      await saveOutboundAndSend(
        `almedia_${event.providerEventId}`.slice(0, 120),
        phoneNumber,
        DAILY_LIMIT_MESSAGE,
      );
    }
    return;
  }

  // Debounce: (re)start the window; the reply covers every message that arrives within it.
  scheduleDebouncedReply(phoneKey, {
    phoneNumber,
    studentName: inbound.name,
    providerMessageId: inbound.providerMessageId,
    lastMessageDbId: savedInbound.id,
  });
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
