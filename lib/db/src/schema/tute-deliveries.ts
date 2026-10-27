import { createInsertSchema } from "drizzle-zod";
import {
  index,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { z } from "zod/v4";
import { deliveryStatusEnum } from "./enums";

export const tuteDeliveriesTable = pgTable(
  "tute_deliveries",
  {
    id: serial("id").primaryKey(),
    phoneNumber: text("phone_number").notNull(),
    studentName: text("student_name"),
    month: text("month").notNull(),
    trackingNumber: text("tracking_number").notNull(),
    address: text("address"),
    status: deliveryStatusEnum("status").notNull().default("Dispatched"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("tute_deliveries_phone_idx").on(table.phoneNumber),
    index("tute_deliveries_month_idx").on(table.month),
    uniqueIndex("tute_deliveries_phone_month_unique").on(
      table.phoneNumber,
      table.month,
    ),
  ],
);

export const insertTuteDeliverySchema = createInsertSchema(tuteDeliveriesTable).omit({
  id: true,
  createdAt: true,
});
export type InsertTuteDelivery = z.infer<typeof insertTuteDeliverySchema>;
export type TuteDelivery = typeof tuteDeliveriesTable.$inferSelect;
