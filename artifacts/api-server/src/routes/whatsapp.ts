import { Router, type IRouter } from "express";
import { ReceiveWhatsAppWebhookResponse } from "@workspace/api-zod";
import { db, webhookEventsTable } from "@workspace/db";
import { isYCloudConfigured } from "../lib/ycloud";
import { verifyYCloudSignature } from "../lib/webhook-signature";
import { isGroupChatEvent } from "../lib/whatsapp-event";

const router: IRouter = Router();

router.post("/webhook/whatsapp", async (req, res): Promise<void> => {
  const rawBody = req.body;
  if (!Buffer.isBuffer(rawBody)) {
    res.status(400).json({ error: "Expected a raw JSON request body." });
    return;
  }

  if (!isYCloudConfigured()) {
    res.status(503).json({ error: "WhatsApp webhook verification is not configured." });
    return;
  }

  if (
    !verifyYCloudSignature(
      rawBody,
      req.header("ycloud-signature"),
      process.env.YCLOUD_WEBHOOK_SECRET,
    )
  ) {
    res.status(401).json({ error: "Invalid webhook signature." });
    return;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody.toString("utf8"));
  } catch {
    res.status(400).json({ error: "Webhook body must be valid JSON." });
    return;
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    res.status(400).json({ error: "Webhook event must be a JSON object." });
    return;
  }

  const event = payload as Record<string, unknown>;
  const eventId = typeof event.id === "string" ? event.id : "";
  const eventType = typeof event.type === "string" ? event.type : "";
  if (!eventId || !eventType || eventId.length > 255 || eventType.length > 255) {
    res.status(400).json({ error: "Webhook event id and type are required." });
    return;
  }

  // The assistant only serves 1-on-1 direct messages: acknowledge and discard group events.
  if (isGroupChatEvent(event)) {
    res.json(ReceiveWhatsAppWebhookResponse.parse({ accepted: false }));
    return;
  }

  try {
    const inserted = await db
      .insert(webhookEventsTable)
      .values({
        providerEventId: eventId,
        eventType,
        payload: event,
      })
      .onConflictDoNothing()
      .returning({ providerEventId: webhookEventsTable.providerEventId });

    res.json(ReceiveWhatsAppWebhookResponse.parse({ accepted: inserted.length > 0 }));
  } catch (error) {
    req.log.error({ eventId }, "Could not persist WhatsApp webhook event");
    res.status(503).json({ error: "Webhook event could not be stored. Please retry." });
  }
});

export default router;
