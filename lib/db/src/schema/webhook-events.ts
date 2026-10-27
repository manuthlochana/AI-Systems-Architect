import { index, integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const webhookEventsTable = pgTable("webhook_events", {
  providerEventId: text("provider_event_id").primaryKey(),
  eventType: text("event_type").notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
  status: text("status").notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  processingAt: timestamp("processing_at", { withTimezone: true }),
  lastError: text("last_error"),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("webhook_events_status_received_idx").on(table.status, table.receivedAt),
]);
