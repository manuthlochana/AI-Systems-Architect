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

export interface ParsedStaffOutboundMessage {
  phoneNumber: string;
  body: string;
  providerMessageId?: string;
  externalId?: string;
  sentAt?: Date;
  status?: string;
}

export function parseStaffOutboundMessage(
  payload: JsonObject,
): ParsedStaffOutboundMessage | undefined {
  const message = asJsonObject(payload.whatsappMessage);
  if (!message) return undefined;

  const to = typeof message.to === "string" ? message.to : "";
  if (!to) return undefined;

  const externalId = typeof message.externalId === "string" ? message.externalId : "";
  // Outbound messages dispatched by the bot always use externalId starting with almedia_
  if (externalId && externalId.startsWith("almedia_")) {
    return undefined;
  }

  const text = asJsonObject(message.text);
  const body =
    typeof text?.body === "string"
      ? text.body.trim().slice(0, 4000)
      : `[WhatsApp ${message.type || "outbound"} message]`;

  const providerMessageId =
    typeof message.wamid === "string"
      ? message.wamid
      : typeof message.id === "string"
        ? message.id
        : undefined;

  const status = typeof message.status === "string" ? message.status : undefined;

  const sendTimeStr =
    typeof message.sendTime === "string"
      ? message.sendTime
      : typeof payload.createTime === "string"
        ? payload.createTime
        : undefined;
  const sentAt = sendTimeStr ? new Date(sendTimeStr) : new Date();

  return {
    phoneNumber: to,
    body,
    providerMessageId,
    externalId: externalId || undefined,
    sentAt: Number.isNaN(sentAt.getTime()) ? new Date() : sentAt,
    status,
  };
}
