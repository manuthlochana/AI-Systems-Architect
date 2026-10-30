import { and, asc, desc, eq, gte, isNull, lt, or, sql } from "drizzle-orm";
import {
  conversationMessagesTable,
  conversationsTable,
  db,
  suggestedKnowledgeItemsTable,
  webhookEventsTable,
} from "@workspace/db";
import { generateStudentReply } from "./ai-agent";
import { logger } from "./logger";
import { normalizePhoneNumber, sanitizePhone9Digits, toPhoneKey } from "./spreadsheet";
import {
  isGroupChatEvent,
  parseInboundMessage,
  parseStaffOutboundMessage,
} from "./whatsapp-event";
import { isYCloudConfigured, sendWhatsAppTyping, sendYCloudText } from "./ycloud";

const MAX_ATTEMPTS = 5;
const RETRY_DELAY_MS = 15_000;
const PROCESSING_LEASE_MS = 3 * 60_000;
const WHATSAPP_SESSION_MS = 24 * 60 * 60_000;
const HUMAN_HANDOFF_MS = 48 * 60 * 60 * 1000;

/** Rapid-fire messages inside this window are merged into one Gemini prompt. */
const DEBOUNCE_WINDOW_MS = 2_000;
const DEBOUNCE_MAX_RETRIES = 2;
const DEBOUNCE_RETRY_DELAY_MS = 15_000;

const DAILY_MESSAGE_LIMIT = 25;
const COLOMBO_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const DAILY_LIMIT_MESSAGE =
  "ඔබ අද දිනට හිමි පණිවිඩ සීමාව ඉක්මවා ඇත. හදිසි අවශ්‍යතාවයක් සඳහා කාර්යාලය අමතන්න: 071 016 1699.";
const NON_TEXT_WARNING_MESSAGE =
  "පුතේ, දැනට මට ලිඛිත පණිවිඩ (Text) පමණක් කියවිය හැක. කරුණාකර ඔබගේ ගැටලුව Type කර එවන්න.";

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
  clearTimeout(entry.timer);
  debounceQueue.delete(key);

  try {
    const [conversation] = await db
      .select()
      .from(conversationsTable)
      .where(eq(conversationsTable.phoneNumber, entry.phoneNumber))
      .limit(1);
    // Staff may have taken over while the debounce window was open.
    if (conversation?.mode === "human") return;

    // Dispatch typing indicator while AI generates the response
    void sendWhatsAppTyping(entry.phoneNumber, entry.providerMessageId).catch(() => {});

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

  const mode = existingConversation?.mode ?? "bot";
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

  // SMART HUMAN HANDOFF & 30-MINUTE AUTO-RESET:
  // If mode === 'human':
  // - Inspect the timestamp of the last message sent by staff (conversationsTable.lastStaffMessageAt).
  // - If elapsed time > 30 minutes:
  //   - Automatically update conversation state: mode = 'bot'.
  //   - Log: [Auto-Reset] Inactivity threshold (30m) exceeded. Conversation switched back to bot mode.
  //   - Proceed to process the message through the Gemini AI agent.
  // - If elapsed time <= 30 minutes:
  //   - Keep the bot completely silent.
  //   - Log: [Muted] Human conversation active within 30-minute grace window. Skipping AI response.
  //   - Terminate processing for this message (do not trigger AI).
  if (mode === "human") {
    let lastStaffAt = existingConversation?.lastStaffMessageAt;

    // Fallback: If lastStaffMessageAt wasn't explicitly populated in conversationsTable,
    // look up the newest outbound staff message in conversationMessagesTable
    if (!lastStaffAt) {
      const [lastStaffMessage] = await db
        .select({ createdAt: conversationMessagesTable.createdAt })
        .from(conversationMessagesTable)
        .where(
          and(
            eq(conversationMessagesTable.phoneNumber, phoneNumber),
            eq(conversationMessagesTable.direction, "outbound"),
            or(
              isNull(conversationMessagesTable.externalId),
              sql`${conversationMessagesTable.externalId} NOT LIKE 'almedia_%'`,
            ),
          ),
        )
        .orderBy(desc(conversationMessagesTable.createdAt))
        .limit(1);

      if (lastStaffMessage?.createdAt) {
        lastStaffAt = lastStaffMessage.createdAt;
      }
    }

    const elapsedMs = lastStaffAt
      ? Date.now() - new Date(lastStaffAt).getTime()
      : Infinity;

    const THIRTY_MINUTES_MS = 30 * 60 * 1000;

    if (elapsedMs > THIRTY_MINUTES_MS) {
      await db
        .update(conversationsTable)
        .set({ mode: "bot" })
        .where(eq(conversationsTable.phoneNumber, phoneNumber));

      logger.info(
        {
          phone: phoneNumber,
          eventId: event.providerEventId,
          lastStaffMessageAt: lastStaffAt,
          minutesElapsed: elapsedMs === Infinity ? "never" : (elapsedMs / (60 * 1000)).toFixed(1),
        },
        "[Auto-Reset] Inactivity threshold (30m) exceeded. Conversation switched back to bot mode.",
      );
      // Proceed to process the message through the Gemini AI agent!
    } else {
      const pending = debounceQueue.get(phoneKey);
      if (pending) {
        clearTimeout(pending.timer);
        debounceQueue.delete(phoneKey);
      }
      logger.info(
        {
          phone: phoneNumber,
          eventId: event.providerEventId,
          lastStaffMessageAt: lastStaffAt,
          minutesRemaining: ((THIRTY_MINUTES_MS - elapsedMs) / (60 * 1000)).toFixed(1),
        },
        "[Muted] Within 30-minute staff interaction window.",
      );
      return;
    }
  }

  // Media / Audio / Document / Sticker: Discard from AI pipeline to prevent crashes, memory exhaustion and API fees.
  if (inbound.type !== "text") {
    await saveOutboundAndSend(
      `almedia_media_${event.providerEventId}`.slice(0, 120),
      phoneNumber,
      NON_TEXT_WARNING_MESSAGE,
    );
    logger.info(
      { eventId: event.providerEventId, type: inbound.type, phone: phoneNumber },
      "Non-text inbound WhatsApp message responded with polite text-only warning",
    );
    return;
  }

  if (!inbound.body) return;

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

  // Display WhatsApp typing indicator immediately upon debouncing
  void sendWhatsAppTyping(phoneNumber, inbound.providerMessageId).catch(() => {});
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

async function processOutboundOrUpdate(event: WebhookEvent): Promise<void> {
  const staffMsg = parseStaffOutboundMessage(event.payload);
  if (!staffMsg) return;

  let phoneNumber: string;
  let phoneKey: string;
  try {
    phoneNumber = normalizePhoneNumber(staffMsg.phoneNumber);
    phoneKey = toPhoneKey(phoneNumber);
  } catch {
    return;
  }

  // Cancel any pending debounce timer for this student so bot stays completely silent
  const pending = debounceQueue.get(phoneKey);
  if (pending) {
    clearTimeout(pending.timer);
    debounceQueue.delete(phoneKey);
  }

  const now = staffMsg.sentAt || new Date();

  // If this message was already recorded in conversationMessagesTable, just update delivery status if needed
  if (staffMsg.providerMessageId) {
    const [existing] = await db
      .select({ id: conversationMessagesTable.id })
      .from(conversationMessagesTable)
      .where(eq(conversationMessagesTable.providerMessageId, staffMsg.providerMessageId))
      .limit(1);

    if (existing) {
      if (staffMsg.status) {
        await db
          .update(conversationMessagesTable)
          .set({ deliveryStatus: staffMsg.status })
          .where(eq(conversationMessagesTable.id, existing.id));
      }
      return;
    }
  }

  // Whenever an outbound message is dispatched to a student (either from the WhatsApp Business mobile app or Admin Dashboard):
  // Update the student's conversation record:
  // - mode = 'human'
  // - last_staff_message_at = new Date()
  await db
    .insert(conversationsTable)
    .values({
      phoneNumber,
      mode: "human",
      lastStaffMessageAt: now,
      lastMessageAt: now,
    })
    .onConflictDoUpdate({
      target: conversationsTable.phoneNumber,
      set: {
        mode: "human",
        lastStaffMessageAt: now,
        lastMessageAt: sql`greatest(${conversationsTable.lastMessageAt}, ${now})`,
      },
    });

  if (staffMsg.providerMessageId) {
    await db
      .insert(conversationMessagesTable)
      .values({
        phoneNumber,
        direction: "outbound",
        body: staffMsg.body,
        providerMessageId: staffMsg.providerMessageId,
        externalId: staffMsg.externalId,
        deliveryStatus: staffMsg.status || "sent",
        createdAt: now,
      })
      .onConflictDoNothing();
  }

  logger.info(
    { phone: phoneNumber, providerMessageId: staffMsg.providerMessageId },
    "Staff outbound message tracked: mode set to 'human', last_staff_message_at updated",
  );

  // Shadow Learning Queue: Capture Q&A pair when staff replies to a student
  if (
    staffMsg.body &&
    !staffMsg.body.startsWith("[WhatsApp ") &&
    staffMsg.body.trim().length > 1
  ) {
    try {
      const [lastInbound] = await db
        .select({ body: conversationMessagesTable.body })
        .from(conversationMessagesTable)
        .where(
          and(
            eq(conversationMessagesTable.phoneNumber, phoneNumber),
            eq(conversationMessagesTable.direction, "inbound"),
          ),
        )
        .orderBy(desc(conversationMessagesTable.createdAt))
        .limit(1);

      if (
        lastInbound?.body &&
        !lastInbound.body.startsWith("[WhatsApp ") &&
        lastInbound.body.trim().length > 1
      ) {
        await db.insert(suggestedKnowledgeItemsTable).values({
          sourceConversationId: phoneNumber,
          studentQuestion: lastInbound.body.trim(),
          humanStaffResponse: staffMsg.body.trim(),
          suggestedCategory: "faq",
          status: "pending",
        });
        logger.info(
          { phone: phoneNumber },
          "[Shadow Learning] Captured student question and staff response into suggested_knowledge_items",
        );
      }
    } catch (err) {
      logger.warn(
        { err, phone: phoneNumber },
        "Failed to record shadow learning suggestion",
      );
    }
  }
}

async function processOneEvent(): Promise<boolean> {
  const event = await claimNextEvent();
  if (!event) return false;
  try {
    if (event.eventType === "whatsapp.inbound_message.received") {
      await processInbound(event);
    } else {
      await processOutboundOrUpdate(event);
    }
    await db
      .update(webhookEventsTable)
      .set({ status: "processed", processingAt: null, lastError: null })
      .where(eq(webhookEventsTable.providerEventId, event.providerEventId));
  } catch (error) {
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
      {
        eventId: event.providerEventId,
        attempt: event.attempts,
        terminal,
        err: error instanceof Error ? error.message : String(error),
      },
      "WhatsApp webhook processing failed",
    );
  }
  return true;
}

let running = false;
let workPending = false;

async function poll(): Promise<void> {
  if (running) {
    workPending = true;
    return;
  }
  if (!process.env.GEMINI_API_KEY || !isYCloudConfigured()) return;

  running = true;
  try {
    do {
      workPending = false;
      for (let processed = 0; processed < 10; processed += 1) {
        if (!(await processOneEvent())) break;
      }
    } while (workPending);
  } catch (error) {
    logger.error(
      { err: error instanceof Error ? error.message : String(error) },
      "WhatsApp worker could not query the event queue",
    );
  } finally {
    running = false;
  }
}

/** Immediately triggers a worker queue pump without waiting for the next 5s poll interval. */
export function triggerImmediateWorker(): void {
  setImmediate(() => {
    void poll();
  });
}

/** Graceful shutdown helper: flushes any in-memory debounced student replies before process exit. */
export async function flushAllDebouncedReplies(): Promise<void> {
  const keys = Array.from(debounceQueue.keys());
  if (!keys.length) return;
  logger.info({ count: keys.length }, "Flushing pending debounced replies before shutdown");
  await Promise.allSettled(keys.map((key) => flushDebounced(key)));
}

export function startWebhookWorker(): void {
  void poll();
  setInterval(() => void poll(), 5_000);
}
