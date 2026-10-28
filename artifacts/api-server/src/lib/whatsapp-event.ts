export type JsonObject = Record<string, unknown>;

export interface ParsedInboundMessage {
  phoneValue: string;
  providerMessageId: string;
  body: string;
  name: string | null;
  type: string;
}

export function asJsonObject(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

export function isGroupChatEvent(payload: JsonObject): boolean {
  const message = asJsonObject(payload.whatsappInboundMessage);
  if (!message) return false;

  const chat = asJsonObject(message.chat);
  const identifiers = [
    message.from,
    message.chatId,
    message.chat_id,
    chat?.id,
    payload.chatId,
    payload.chat_id,
  ];
  if (
    identifiers.some(
      (value) => typeof value === "string" && value.toLowerCase().includes("@g.us"),
    )
  ) {
    return true;
  }

  return Boolean(
    message.isGroup ||
      message.group ||
      message.groupMetadata ||
      message.groupInfo ||
      message.chatType === "group" ||
      chat?.isGroup ||
      chat?.type === "group" ||
      payload.group ||
      payload.groupMetadata,
  );
}

export function parseInboundMessage(payload: JsonObject): ParsedInboundMessage | undefined {
  const message = asJsonObject(payload.whatsappInboundMessage);
  if (!message) return undefined;

  const text = asJsonObject(message.text);
  const profile = asJsonObject(message.customerProfile);
  const phoneValue = typeof message.from === "string" ? message.from : "";
  const providerMessageId =
    typeof message.wamid === "string"
      ? message.wamid
      : typeof message.id === "string"
        ? message.id
        : "";
  const body =
    typeof text?.body === "string" ? text.body.trim().slice(0, 4000) : "";
  const name = typeof profile?.name === "string" ? profile.name.slice(0, 120) : null;
  const type = typeof message.type === "string" ? message.type : "unknown";

  return { phoneValue, providerMessageId, body, name, type };
}
