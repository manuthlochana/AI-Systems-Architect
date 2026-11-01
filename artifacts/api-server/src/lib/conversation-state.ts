import { conversationsTable, db } from "@workspace/db";
import { eq } from "drizzle-orm";
import { getBotSettings } from "./bot-settings";
import { emitDashboardEvent, kvDel, kvGet, kvSet } from "./kv";
import { logger } from "./logger";

export const lockKey = (phoneNumber: string) => `chat:lock:${phoneNumber}`;

/** Admin took over: mode=human, rolling lock (default 4h) reset on every admin activity. */
export async function lockForAdmin(phoneNumber: string, at: Date = new Date()): Promise<void> {
  const settings = await getBotSettings();
  const ttl = Math.max(1, settings.handoverTimeoutHours) * 3600;
  await kvSet(lockKey(phoneNumber), "locked", ttl);
  await db
    .insert(conversationsTable)
    .values({
      phoneNumber,
      mode: "human",
      lastAdminActivityAt: at,
      lastStaffMessageAt: at,
      lastMessageAt: at,
      needsAttention: false,
    })
    .onConflictDoUpdate({
      target: conversationsTable.phoneNumber,
      set: {
        mode: "human",
        lastAdminActivityAt: at,
        lastStaffMessageAt: at,
        needsAttention: false,
      },
    });
  emitDashboardEvent("conversation.updated", { phoneNumber, status: "admin_locked" });
}

/** Bot decided it cannot help: mute the bot and flag the chat for the office. */
export async function escalateConversation(phoneNumber: string, reason: string): Promise<void> {
  await db
    .update(conversationsTable)
    .set({ mode: "human", needsAttention: true, escalationReason: reason.slice(0, 500) })
    .where(eq(conversationsTable.phoneNumber, phoneNumber));
  logger.warn({ phone: phoneNumber, reason }, "[Escalation] Admin alert: conversation needs attention");
  emitDashboardEvent("conversation.escalated", { phoneNumber, reason });
}

/** Clears lock + attention flag and hands the chat back to Meedi. */
export async function releaseToBot(phoneNumber: string): Promise<void> {
  await kvDel(lockKey(phoneNumber));
  await db
    .update(conversationsTable)
    .set({ mode: "bot", needsAttention: false, escalationReason: null })
    .where(eq(conversationsTable.phoneNumber, phoneNumber));
  emitDashboardEvent("conversation.updated", { phoneNumber, status: "bot" });
}

/** True while an admin lock is active (Redis key, or DB timestamp as fallback). */
export async function isAdminLockActive(
  phoneNumber: string,
  lastAdminActivityAt: Date | null | undefined,
  timeoutHours: number,
): Promise<boolean> {
  if (await kvGet(lockKey(phoneNumber))) return true;
  if (lastAdminActivityAt) {
    return Date.now() - new Date(lastAdminActivityAt).getTime() < timeoutHours * 3600_000;
  }
  return false;
}
