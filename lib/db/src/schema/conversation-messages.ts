import { createInsertSchema } from "drizzle-zod";
import { index, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { z } from "zod/v4";
import { messageDirectionEnum } from "./enums";

export const conversationMessagesTable = pgTable(
  "conversation_messages",
  {
    id: serial("id").primaryKey(),
    phoneNumber: text("phone_number").notNull(),
    direction: messageDirectionEnum("direction").notNull(),
    body: text("body").notNull(),
    providerMessageId: text("provider_message_id"),
    externalId: text("external_id"),
    deliveryStatus: text("delivery_status").notNull().default("received"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("conversation_messages_phone_created_idx").on(
      table.phoneNumber,
      table.createdAt,
    ),
    uniqueIndex("conversation_messages_provider_id_unique").on(
      table.providerMessageId,
    ),
    uniqueIndex("conversation_messages_external_id_unique").on(table.externalId),
  ],
);

export const insertConversationMessageSchema = createInsertSchema(
  conversationMessagesTable,
).omit({ id: true, createdAt: true });
export type InsertConversationMessage = z.infer<
  typeof insertConversationMessageSchema
>;
export type ConversationMessage = typeof conversationMessagesTable.$inferSelect;
