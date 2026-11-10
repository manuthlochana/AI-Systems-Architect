import { createInsertSchema } from "drizzle-zod";
import { pgTable, real, text, timestamp } from "drizzle-orm/pg-core";
import { z } from "zod/v4";
import { contentCategoryEnum } from "./enums";

export const dynamicContentTable = pgTable("dynamic_content", {
  key: text("key").primaryKey(),
  category: contentCategoryEnum("category").notNull(),
  title: text("title").notNull(),
  content: text("content").notNull(),
  source: text("source").notNull().default("manual"),
  confidence: real("confidence").notNull().default(1.0),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const insertDynamicContentSchema = createInsertSchema(
  dynamicContentTable,
).omit({ updatedAt: true });
export type InsertDynamicContent = z.infer<typeof insertDynamicContentSchema>;
export type DynamicContent = typeof dynamicContentTable.$inferSelect;
