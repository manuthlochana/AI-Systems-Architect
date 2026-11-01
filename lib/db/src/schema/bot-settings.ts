import { boolean, integer, pgTable, real, text, timestamp } from "drizzle-orm/pg-core";

/** Singleton row (id = 1) holding Meedi's live, dashboard-editable configuration. */
export const botSettingsTable = pgTable("bot_settings", {
  id: integer("id").primaryKey().default(1),
  systemPrompt: text("system_prompt").notNull().default(""),
  enabled: boolean("enabled").notNull().default(true),
  temperature: real("temperature").notNull().default(0.4),
  handoverTimeoutHours: integer("handover_timeout_hours").notNull().default(4),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type BotSettings = typeof botSettingsTable.$inferSelect;
