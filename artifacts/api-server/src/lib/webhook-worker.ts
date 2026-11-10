import { and, asc, desc, eq, gte, isNull, lt, or, sql } from "drizzle-orm";
import {
  conversationMessagesTable,
  conversationsTable,
  db,
  webhookEventsTable,
} from "@workspace/db";
import { generateStudentReply } from "./ai-agent";
import { getBotSettings } from "./bot-settings";
import { escalateConversation, lockForAdmin, lockKey, releaseToBot } from "./conversation-state";
import { emitDashboardEvent, kvDrain, kvGet, kvPush } from "./kv";
import { logger } from "./logger";
import { distillAndCaptureLearning, runAutonomousMemoryCycle } from "./reflection";
import { normalizePhoneNumber, toPhoneKey } from "./phone";
import {
  isGroupChatEvent,
  isSilentInboundType,
  parseInboundMessage,
  parseStaffOutboundMessage,
  RELEASE_EMOJIS,
} from "./whatsapp-event";
import { isYCloudConfigured, sendWhatsAppTyping, sendYCloudText } from "./ycloud";

const MAX_ATTEMPTS = 5;
const RETRY_DELAY_MS = 15_000;
const PROCESSING_LEASE_MS = 3 * 60_000;
const WHATSAPP_SESSION_MS = 24 * 60 * 60_000;

/** Rapid-fire messages inside this window are merged into one Gemini prompt. */
const DEBOUNCE_WINDOW_MS = 6_000;
const BUFFER_TTL_SECONDS = 120;
const DEBOUNCE_MAX_RETRIES = 2;
const DEBOUNCE_RETRY_DELAY_MS = 15_000;

const DAILY_MESSAGE_LIMIT = 25;
const COLOMBO_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const DAILY_LIMIT_MESSAGE =
  "ඔබ අද දිනට හිමි පණිවිඩ සීමාව ඉක්මවා ඇත. හදිසි අවශ්‍යතාවයක් සඳහා කාර්යාලය අමතන්න: 071 016 1699.";

const IMAGE_RECEIVED_ESCALATION_REPLY =
  "ඔයා එවපු ඡායාරූපය/රිසිට්පත අපේ කාර්යාලයට ලැබුණා 🌸 සුළු වේලාවකින් අපේ සම්බන්ධීකාරකවරයෙක් එය පරීක්ෂා කරලා ඔයාට පිළිතුරක් ලබා දේවි.";

type WebhookEvent = typeof webhookEventsTable.$inferSelect;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

/** In-memory debounce timers keyed by the 9-digit phone key (the text itself lives in the KV buffer). */
const debounceQueue = new Map<string, PendingDebounce>();

const bufferKey = (phoneKey: string) => `chat:buf:${phoneKey}`;

/** Acknowledgements / sign-offs that must never trigger a reply (zero ping-pong). */
export const CLOSING_REGEX =
  /^(ok|okay|ok sir|okay sir|thanks|thanks sir|thank you|thank you sir|hari|hari sir|ela|ow sir|suba dawasak|bye|naa sir|thx|thnx)[\s.!🌸✨📚]*$/i;

async function cancelPendingReply(phoneKey: string): Promise<void> {
  const pending = debounceQueue.get(phoneKey);
  if (pending) {
    clearTimeout(pending.timer);
    debounceQueue.delete(phoneKey);
  }
  await kvDrain(bufferKey(phoneKey));
}

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

/** Mute check shared by ingestion and flush: Redis lock, human mode, or an unexpired DB lock. */
async function isBotMuted(
  conversation: typeof conversationsTable.$inferSelect | undefined,
  phoneNumber: string,
  timeoutHours: number,
): Promise<boolean> {
  const redisLock = Boolean(await kvGet(lockKey(phoneNumber)));
  if (!conversation) return redisLock;
  if (conversation.mode !== "human") return redisLock;
  if (redisLock || conversation.needsAttention) return true;

  // mode === 'human' with no Redis lock: honour the DB timestamp, and auto-release once the
  // rolling window has fully elapsed. Explicit human mode without any staff activity stays muted.
  const lastActivity = conversation.lastAdminActivityAt ?? conversation.lastStaffMessageAt;
  if (!lastActivity) return true;
  const elapsedMs = Date.now() - new Date(lastActivity).getTime();
  if (elapsedMs < timeoutHours * 3600_000) return true;

  await releaseToBot(phoneNumber);
  logger.info(
    { phone: phoneNumber, hoursElapsed: (elapsedMs / 3600_000).toFixed(1) },
    "[Auto-Release] Admin lock window expired. Conversation switched back to bot mode.",
  );
  return false;
}

async function flushDebounced(key: string): Promise<void> {
  const entry = debounceQueue.get(key);
  if (!entry) return;
  clearTimeout(entry.timer);
  debounceQueue.delete(key);

  const texts = await kvDrain(bufferKey(key));
  if (!texts.length) return;

  try {
    const settings = await getBotSettings();
    const [conversation] = await db
      .select()
      .from(conversationsTable)
      .where(eq(conversationsTable.phoneNumber, entry.phoneNumber))
      .limit(1);

    // Staff may have taken over (or Meedi switched off) while the debounce window was open.
    if (!settings.enabled) return;
    if (await isBotMuted(conversation, entry.phoneNumber, settings.handoverTimeoutHours)) return;

    void sendWhatsAppTyping(entry.phoneNumber, entry.providerMessageId).catch(() => {});

    // Burst aggregation: every message inside the window becomes ONE newline-joined prompt.
    const reply = await generateStudentReply({
      phoneNumber: entry.phoneNumber,
      studentName: conversation?.studentName ?? entry.studentName,
      batch: conversation?.batch ?? "unknown",
      providerMessageId: entry.providerMessageId,
      turnText: texts.join("\n"),
    });
    await db
      .update(conversationsTable)
      .set({ lastIntent: reply.lastIntent, lastMessageAt: new Date() })
      .where(eq(conversationsTable.phoneNumber, entry.phoneNumber));

    const bubbles = reply.messages.length
      ? reply.messages
      : [{ text: reply.text, delayMs: 800 }];

    for (let idx = 0; idx < bubbles.length; idx += 1) {
      const bubble = bubbles[idx];
      if (!bubble?.text.trim()) continue;

      // Re-verify the admin hasn't interrupted mid-burst
      if (idx > 0) {
        const [latestConv] = await db
          .select()
          .from(conversationsTable)
          .where(eq(conversationsTable.phoneNumber, entry.phoneNumber))
          .limit(1);
        if (await isBotMuted(latestConv, entry.phoneNumber, settings.handoverTimeoutHours)) {
          break;
        }
      }

      void sendWhatsAppTyping(
        entry.phoneNumber,
        idx === 0 ? entry.providerMessageId : undefined,
      ).catch(() => {});

      const clampedDelay = Math.max(600, Math.min(1200, bubble.delayMs || 800));
      await sleep(clampedDelay);

      const suffix = idx === 0 ? "" : `_b${idx}`;
      const externalId = `almedia_d${key}_${entry.lastMessageDbId}${suffix}`.slice(0, 120);
      await saveOutboundAndSend(externalId, entry.phoneNumber, bubble.text.trim());
    }

    emitDashboardEvent("message.outbound", { phoneNumber: entry.phoneNumber });
  } catch (error) {
    // Put the burst back so a retry (or a newer burst) still covers these messages.
    for (const text of texts) await kvPush(bufferKey(key), text, BUFFER_TTL_SECONDS);
    if (debounceQueue.has(key)) return;
    const errDetail = error instanceof Error ? error.message : String(error);
    if (entry.retries < DEBOUNCE_MAX_RETRIES) {
      logger.warn(
        { retry: entry.retries + 1, error: errDetail, phone: entry.phoneNumber },
        "Debounced reply failed; retrying",
      );
      scheduleDebouncedReply(key, entry, DEBOUNCE_RETRY_DELAY_MS, entry.retries + 1);
    } else {
      await kvDrain(bufferKey(key));
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

  // Silent drop: reactions / deleted messages never reach the AI and never produce a reply.
  if (isSilentInboundType(inbound.type)) {
    logger.info({ eventId: event.providerEventId, type: inbound.type }, "Silently dropped system event");
    return;
  }

  let phoneNumber: string;
  let phoneKey: string;
  try {
    phoneNumber = normalizePhoneNumber(inbound.phoneValue);
    phoneKey = toPhoneKey(phoneNumber);
  } catch {
    logger.warn({ eventId: event.providerEventId }, "Ignored invalid WhatsApp sender number");
    return;
  }

  const settings = await getBotSettings();

  const [existingConversation] = await db
    .select()
    .from(conversationsTable)
    .where(eq(conversationsTable.phoneNumber, phoneNumber))
    .limit(1);

  const messageBody = inbound.body || `[WhatsApp ${inbound.type} message]`;

  await db
    .insert(conversationsTable)
    .values({
      phoneNumber,
      studentName: inbound.name,
      mode: existingConversation?.mode ?? "bot",
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
  emitDashboardEvent("message.inbound", { phoneNumber });

  // BOT MUTE ENFORCEMENT: Redis sliding lock OR human mode => store only, stay 100% silent.
  if (await isBotMuted(existingConversation, phoneNumber, settings.handoverTimeoutHours)) {
    await cancelPendingReply(phoneKey);
    logger.info(
      { phone: phoneNumber, eventId: event.providerEventId },
      "[Muted] Admin lock / human mode active. Message stored, Meedi stays silent.",
    );
    return;
  }

  if (!settings.enabled) {
    logger.info({ phone: phoneNumber }, "[Disabled] Meedi is switched off globally. Message stored only.");
    return;
  }

  // Inbound image (e.g., bank payment slip, NIC/School ID, or question photo):
  // Store image with URL for Inbox preview, escalate to human staff, and send polite confirmation.
  if (inbound.type === "image") {
    await cancelPendingReply(phoneKey);
    await escalateConversation(phoneNumber, "Student sent an image / payment slip");
    const age = Date.now() - event.receivedAt.getTime();
    if (age <= WHATSAPP_SESSION_MS) {
      await saveOutboundAndSend(
        `almedia_img_${savedInbound.id}`.slice(0, 120),
        phoneNumber,
        IMAGE_RECEIVED_ESCALATION_REPLY,
      );
      emitDashboardEvent("message.outbound", { phoneNumber });
    }
    logger.info(
      { phone: phoneNumber, mediaUrl: inbound.mediaUrl },
      "[Inbound Image] Stored image message and escalated to human staff",
    );
    return;
  }

  // Other non-text media (voice / documents / video): stored for the office, never answered by the bot.
  if (inbound.type !== "text" || !inbound.body) {
    logger.info(
      { eventId: event.providerEventId, type: inbound.type, phone: phoneNumber },
      "Non-text message stored silently",
    );
    return;
  }

  const age = Date.now() - event.receivedAt.getTime();
  if (age > WHATSAPP_SESSION_MS) {
    logger.info({ eventId: event.providerEventId }, "Skipped reply outside the WhatsApp service window");
    return;
  }

  // CLOSING / ACKNOWLEDGEMENT FILTER: log silently, never call the LLM.
  if (CLOSING_REGEX.test(inbound.body.trim())) {
    await db
      .update(conversationMessagesTable)
      .set({ deliveryStatus: "closed_silently" })
      .where(eq(conversationMessagesTable.id, savedInbound.id));
    logger.info({ phone: phoneNumber, eventId: event.providerEventId }, "Closing message logged silently; no reply");
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
    await cancelPendingReply(phoneKey);
    if (todayCount === DAILY_MESSAGE_LIMIT + 1) {
      await saveOutboundAndSend(
        `almedia_${event.providerEventId}`.slice(0, 120),
        phoneNumber,
        DAILY_LIMIT_MESSAGE,
      );
    }
    return;
  }

  // 6-second burst buffer: append this message, (re)start the window.
  await kvPush(bufferKey(phoneKey), inbound.body, BUFFER_TTL_SECONDS);
  scheduleDebouncedReply(phoneKey, {
    phoneNumber,
    studentName: inbound.name,
    providerMessageId: inbound.providerMessageId,
    lastMessageDbId: savedInbound.id,
  });

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

/**
 * Cognitive Learning Distillation: passes human-staff interventions through the PII-scrubbing
 * reflection engine so only anonymized, globally reusable FAQ/policy insights enter the queue.
 */
export async function captureShadowLearning(phoneNumber: string, staffBody: string): Promise<void> {
  void distillAndCaptureLearning(phoneNumber, staffBody).catch((err) => {
    logger.warn({ err, phone: phoneNumber }, "Cognitive learning distillation failed");
  });
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

  // Admin reaction: a release emoji hands the chat back to Meedi; any other reaction is ignored.
  if (staffMsg.type === "reaction") {
    if (staffMsg.reactionEmoji && RELEASE_EMOJIS.includes(staffMsg.reactionEmoji)) {
      await releaseToBot(phoneNumber);
      logger.info(
        { phone: phoneNumber, emoji: staffMsg.reactionEmoji },
        "[Release] Admin reaction released the conversation back to bot mode",
      );
    }
    return;
  }

  // Cancel any pending reply for this student so the bot stays completely silent.
  await cancelPendingReply(phoneKey);

  const now = staffMsg.sentAt || new Date();

  // Already recorded (status update webhook): only refresh delivery status, no new lock activity.
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

  // Manual admin message (text / voice / image / document): mode=human + rolling 4h lock reset.
  await lockForAdmin(phoneNumber, now);

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
  emitDashboardEvent("message.outbound", { phoneNumber });

  logger.info(
    { phone: phoneNumber, providerMessageId: staffMsg.providerMessageId, type: staffMsg.type },
    "[Admin Lock] Manual admin message tracked: mode=human, sliding lock refreshed",
  );

  await captureShadowLearning(phoneNumber, staffMsg.body);
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

  // Autonomous Memory Worker: checks every 2 minutes for staff conversations that reached >= 30 minutes of inactivity
  setTimeout(() => {
    void runAutonomousMemoryCycle(48).catch((err) => {
      logger.warn({ err }, "[Autonomous Memory] Initial reflection cycle failed");
    });
  }, 15_000);

  setInterval(() => {
    void runAutonomousMemoryCycle(48).catch((err) => {
      logger.warn({ err }, "[Autonomous Memory] Periodic reflection cycle failed");
    });
  }, 2 * 60_000);
}
