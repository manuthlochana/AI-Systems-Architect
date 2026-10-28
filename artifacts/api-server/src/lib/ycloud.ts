const YCLOUD_SEND_URL = "https://api.ycloud.com/v2/whatsapp/messages/sendDirectly";

export function isYCloudConfigured(): boolean {
  return Boolean(
    process.env.YCLOUD_API_KEY &&
      process.env.YCLOUD_FROM_NUMBER &&
      process.env.YCLOUD_WEBHOOK_SECRET,
  );
}

export async function sendYCloudText(
  to: string,
  body: string,
  externalId: string,
): Promise<string | null> {
  const apiKey = process.env.YCLOUD_API_KEY;
  const from = process.env.YCLOUD_FROM_NUMBER;
  if (!apiKey || !from) {
    throw new Error("YCloud API key and sender phone number are required");
  }

  const response = await fetch(YCLOUD_SEND_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": apiKey,
    },
    body: JSON.stringify({
      from,
      to,
      type: "text",
      text: { body },
      externalId,
    }),
    signal: AbortSignal.timeout(15_000),
  });

  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(
      `YCloud rejected the message (${response.status}): ${responseText.slice(0, 400)}`,
    );
  }

  if (!responseText.trim()) return null;
  try {
    const result: unknown = JSON.parse(responseText);
    if (result && typeof result === "object" && "id" in result) {
      const id = (result as { id?: unknown }).id;
      return typeof id === "string" ? id : null;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Dispatches a WhatsApp typing status indicator while the AI model is thinking.
 * Fire-and-forget: Catches all errors internally so it never blocks or interrupts the AI execution thread.
 */
export async function sendWhatsAppTyping(
  to: string,
  inboundMessageId?: string | null,
): Promise<void> {
  const apiKey = process.env.YCLOUD_API_KEY;
  if (!apiKey) return;

  try {
    const promises: Promise<unknown>[] = [];

    // Official YCloud WhatsApp inbound messages typing endpoint (marks as read + displays typing)
    if (inboundMessageId) {
      promises.push(
        fetch(
          `https://api.ycloud.com/v2/whatsapp/inboundMessages/${encodeURIComponent(inboundMessageId)}/typing`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-API-Key": apiKey,
            },
            signal: AbortSignal.timeout(5_000),
          },
        ).catch(() => {}),
      );
    }

    // Direct WhatsApp action endpoint
    promises.push(
      fetch("https://api.ycloud.com/v2/whatsapp/messages/action", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": apiKey,
        },
        body: JSON.stringify({ to, action: "typing" }),
        signal: AbortSignal.timeout(5_000),
      }).catch(() => {}),
    );

    await Promise.allSettled(promises);
  } catch {
    // Non-blocking fire-and-forget
  }
}
