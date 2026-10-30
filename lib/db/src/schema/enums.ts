import { pgEnum } from "drizzle-orm/pg-core";

export const batchEnum = pgEnum("student_batch", ["2027", "2028", "unknown"]);
export const studentTypeEnum = pgEnum("student_type", ["new", "existing"]);
export const conversationModeEnum = pgEnum("conversation_mode", ["bot", "human"]);
export const deliveryStatusEnum = pgEnum("delivery_status", [
  "Dispatched",
  "Delivered",
  "Returned",
]);
export const contentCategoryEnum = pgEnum("content_category", [
  "timetable",
  "pricing",
  "general",
  "faq",
  "announcement",
]);
export const recordingStatusEnum = pgEnum("recording_status", [
  "pending",
  "approved",
  "rejected",
]);
export const classTypeEnum = pgEnum("class_type", ["Theory", "Revision"]);
export const recordingStudentTypeEnum = pgEnum("recording_student_type", [
  "Online",
  "Physical",
  "Unknown",
]);
export const messageDirectionEnum = pgEnum("message_direction", [
  "inbound",
  "outbound",
]);
export const suggestionStatusEnum = pgEnum("suggestion_status", [
  "pending",
  "approved",
  "rejected",
]);
