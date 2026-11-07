import { createInsertSchema } from "drizzle-zod";
import { boolean, integer, pgTable, text, timestamp, varchar } from "drizzle-orm/pg-core";
import { z } from "zod/v4";
import {
  batchEnum,
  conversationModeEnum,
  genderEnum,
  onboardingStatusEnum,
  physicalLocationEnum,
  studentClassTypeEnum,
  studentTypeEnum,
} from "./enums";

export const conversationsTable = pgTable("conversations", {
  phoneNumber: text("phone_number").primaryKey(),
  studentName: text("student_name"),
  batch: batchEnum("batch").notNull().default("unknown"),
  studentType: studentTypeEnum("student_type").notNull().default("new"),
  mode: conversationModeEnum("mode").notNull().default("bot"),
  // Permanent student profile (phone_number is the primary key / unique identifier).
  gender: genderEnum("gender").notNull().default("unknown"),
  examYear: integer("exam_year"),
  hometownDistrict: varchar("hometown_district", { length: 100 }),
  otherSubjects: varchar("other_subjects", { length: 200 }),
  classType: studentClassTypeEnum("class_type").notNull().default("undecided"),
  physicalLocation: physicalLocationEnum("physical_location"),
  onboardingStatus: onboardingStatusEnum("onboarding_status").notNull().default("new_lead"),
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
