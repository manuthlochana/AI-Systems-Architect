export type JsonObject = Record<string, unknown>;

export interface ParsedInboundMessage {
  phoneValue: string;
  providerMessageId: string;
  body: string;
  name: string | null;
  type: string;
  mediaUrl?: string;
  mediaCaption?: string;
}

const IMAGE_PREFIX_REGEX = /^\[IMAGE:(https?:\/\/[^\]]+|\/api\/[^\]]+)\](?:\n([\s\S]*))?$/;

export function formatMediaMessageBody(
  mediaUrl: string,
  caption?: string | null,
): string {
  const cleanCaption = caption?.trim() ?? "";
  return cleanCaption ? `[IMAGE:${mediaUrl}]\n${cleanCaption}` : `[IMAGE:${mediaUrl}]`;
}

export function parseMediaMessageBody(body: string): {
  mediaUrl: string | null;
  caption: string;
} {
  const match = body.match(IMAGE_PREFIX_REGEX);
  if (!match) {
    return { mediaUrl: null, caption: body };
  }
  return {
    mediaUrl: match[1] ?? null,
    caption: (match[2] ?? "").trim(),
  };
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

function extractMediaFromPayload(message: JsonObject, type: string): {
  mediaUrl?: string;
  mediaCaption?: string;
} {
  const mediaObj =
    asJsonObject(message[type]) ??
    asJsonObject(message.image) ??
    asJsonObject(message.document) ??
    asJsonObject(message.video) ??
    asJsonObject(message.audio);

  if (!mediaObj) return {};

  const link = typeof mediaObj.link === "string" ? mediaObj.link.trim() : "";
  const url = typeof mediaObj.url === "string" ? mediaObj.url.trim() : "";
  const rawUrl = link || url;
  const mediaUrl =
    rawUrl && (rawUrl.startsWith("https://") || rawUrl.startsWith("http://"))
      ? rawUrl
      : undefined;

  const mediaCaption =
    typeof mediaObj.caption === "string" && mediaObj.caption.trim()
      ? mediaObj.caption.trim().slice(0, 2000)
      : undefined;

  return { mediaUrl, mediaCaption };
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
  const type = typeof message.type === "string" ? message.type : "unknown";
  const { mediaUrl, mediaCaption } = extractMediaFromPayload(message, type);

  const rawTextBody =
    typeof text?.body === "string" ? text.body.trim().slice(0, 4000) : "";
  const body =
    type === "image" && mediaUrl
      ? formatMediaMessageBody(mediaUrl, mediaCaption || rawTextBody)
      : rawTextBody || mediaCaption || "";
  const name = typeof profile?.name === "string" ? profile.name.slice(0, 120) : null;

  return {
    phoneValue,
    providerMessageId,
    body,
    name,
    type,
    mediaUrl,
    mediaCaption,
  };
}

export interface ParsedStaffOutboundMessage {
  phoneNumber: string;
  body: string;
  providerMessageId?: string;
  externalId?: string;
  sentAt?: Date;
  status?: string;
  /** WhatsApp message type (text, image, audio, document, reaction, ...). */
  type: string;
  /** Emoji of an admin reaction (type === "reaction"). */
  reactionEmoji?: string;
  mediaUrl?: string;
  mediaCaption?: string;
}

/** Inbound event types that must never reach the AI or produce any reply. */
const SILENT_INBOUND_TYPES = new Set(["reaction", "revoked"]);

export function isSilentInboundType(type: string): boolean {
  return SILENT_INBOUND_TYPES.has(type);
}

/** Emojis an admin can react with to hand a chat back to the bot. */
export const RELEASE_EMOJIS = ["✅", "🤖"];

export function parseStaffOutboundMessage(
  payload: JsonObject,
): ParsedStaffOutboundMessage | undefined {
  const message = asJsonObject(payload.whatsappMessage);
  if (!message) return undefined;

  const to = typeof message.to === "string" ? message.to : "";
  if (!to) return undefined;

  const type = typeof message.type === "string" ? message.type : "unknown";
  // Automated broadcast / marketing templates are not manual admin interruptions.
  if (type === "template") return undefined;

  const externalId = typeof message.externalId === "string" ? message.externalId : "";
  // Outbound messages dispatched by the bot always use externalId starting with almedia_
  if (externalId && externalId.startsWith("almedia_")) {
    return undefined;
  }

  const text = asJsonObject(message.text);
  const reaction = asJsonObject(message.reaction);
  const reactionEmoji = typeof reaction?.emoji === "string" ? reaction.emoji : undefined;
  const { mediaUrl, mediaCaption } = extractMediaFromPayload(message, type);

  const body =
    type === "image" && mediaUrl
      ? formatMediaMessageBody(mediaUrl, mediaCaption)
      : typeof text?.body === "string"
        ? text.body.trim().slice(0, 4000)
        : mediaCaption || `[WhatsApp ${type} message]`;

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
    type,
    reactionEmoji,
    mediaUrl,
    mediaCaption,
  };
}
