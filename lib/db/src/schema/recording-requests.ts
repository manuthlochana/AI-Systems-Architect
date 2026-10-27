import { createInsertSchema } from "drizzle-zod";
import {
  index,
  pgTable,
  serial,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { z } from "zod/v4";
import { batchEnum, classTypeEnum, recordingStatusEnum } from "./enums";

export const recordingRequestsTable = pgTable(
  "recording_requests",
  {
    id: serial("id").primaryKey(),
    phoneNumber: text("phone_number").notNull(),
    studentName: text("student_name"),
    batch: batchEnum("batch"),
    requestedDate: text("requested_date").notNull(),
    classType: classTypeEnum("class_type"),
    status: recordingStatusEnum("status").notNull().default("pending"),
    zoomLink: text("zoom_link"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("recording_requests_status_created_idx").on(
      table.status,
      table.createdAt,
    ),
    index("recording_requests_phone_idx").on(table.phoneNumber),
  ],
);

export const insertRecordingRequestSchema = createInsertSchema(
  recordingRequestsTable,
).omit({ id: true, createdAt: true });
export type InsertRecordingRequest = z.infer<typeof insertRecordingRequestSchema>;
export type RecordingRequest = typeof recordingRequestsTable.$inferSelect;
