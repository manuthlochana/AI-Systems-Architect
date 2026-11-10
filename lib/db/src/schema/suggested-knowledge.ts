import { createInsertSchema } from "drizzle-zod";
import { pgTable, real, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { z } from "zod/v4";
import { suggestionStatusEnum } from "./enums";

export const suggestedKnowledgeItemsTable = pgTable("suggested_knowledge_items", {
  id: uuid("id").primaryKey().defaultRandom(),
  sourceConversationId: text("source_conversation_id"),
  studentQuestion: text("student_question").notNull(),
  humanStaffResponse: text("human_staff_response").notNull(),
  suggestedCategory: text("suggested_category").notNull().default("faq"),
  confidence: real("confidence").notNull().default(0.85),
  source: text("source").notNull().default("autonomous_reflection"),
  status: suggestionStatusEnum("status").notNull().default("pending"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const insertSuggestedKnowledgeItemSchema = createInsertSchema(
  suggestedKnowledgeItemsTable,
).omit({ id: true, createdAt: true });

export type InsertSuggestedKnowledgeItem = z.infer<
  typeof insertSuggestedKnowledgeItemSchema
>;
export type SuggestedKnowledgeItem =
  typeof suggestedKnowledgeItemsTable.$inferSelect;
