import { createInsertSchema } from "drizzle-zod";
import { boolean, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { z } from "zod/v4";
import { batchEnum, conversationModeEnum, studentTypeEnum } from "./enums";

export const conversationsTable = pgTable("conversations", {
  phoneNumber: text("phone_number").primaryKey(),
  studentName: text("student_name"),
  batch: batchEnum("batch").notNull().default("unknown"),
  studentType: studentTypeEnum("student_type").notNull().default("new"),
  mode: conversationModeEnum("mode").notNull().default("bot"),
  lastIntent: text("last_intent"),
  lastStaffMessageAt: timestamp("last_staff_message_at", { withTimezone: true }),
  lastAdminActivityAt: timestamp("last_admin_activity_at", { withTimezone: true }),
  needsAttention: boolean("needs_attention").notNull().default(false),
  escalationReason: text("escalation_reason"),
  lastMessageAt: timestamp("last_message_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertConversationSchema = createInsertSchema(
  conversationsTable,
).omit({ createdAt: true, lastMessageAt: true });
export type InsertConversation = z.infer<typeof insertConversationSchema>;
export type Conversation = typeof conversationsTable.$inferSelect;
