import { Router, type IRouter } from "express";
import { ReceiveWhatsAppWebhookResponse } from "@workspace/api-zod";
import { db, webhookEventsTable } from "@workspace/db";
import { isYCloudConfigured } from "../lib/ycloud";
import { verifyYCloudSignature } from "../lib/webhook-signature";
import { isGroupChatEvent } from "../lib/whatsapp-event";
import { triggerImmediateWorker } from "../lib/webhook-worker";

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

  // Webhook Replay Attack Mitigation: reject events older than 5 minutes (300,000ms)
  const messageObj =
    typeof event.whatsappInboundMessage === "object" && event.whatsappInboundMessage !== null
      ? (event.whatsappInboundMessage as Record<string, unknown>)
      : undefined;
  const rawTimestamp = event.createTime || messageObj?.sendTime;
  if (rawTimestamp) {
    const eventTime = new Date(String(rawTimestamp)).getTime();
    if (!Number.isNaN(eventTime)) {
      const ageMs = Math.abs(Date.now() - eventTime);
      if (ageMs > 300_000) {
        req.log.warn({ eventId, rawTimestamp, ageMs }, "Rejected stale or replay webhook event");
        res.status(400).json({ error: "Webhook event timestamp is older than 5 minutes." });
        return;
      }
    }
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

    // Instant decoupled pump: trigger worker immediately instead of waiting for 5s poll interval.
    if (inserted.length > 0) {
      triggerImmediateWorker();
    }
  } catch (error) {
    req.log.error({ eventId }, "Could not persist WhatsApp webhook event");
    res.status(503).json({ error: "Webhook event could not be stored. Please retry." });
  }
});

export default router;
