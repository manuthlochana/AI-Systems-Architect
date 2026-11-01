import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  GoogleGenAI,
  Type,
  type Content,
  type FunctionCall,
  type FunctionDeclaration,
  type Part,
} from "@google/genai";
import { and, desc, eq, ilike, inArray, ne, or, sql } from "drizzle-orm";
import {
  conversationMessagesTable,
  conversationsTable,
  db,
  dynamicContentTable,
  tuteDeliveriesTable,
  type BotSettings,
} from "@workspace/db";
import { effectivePersona, ESCALATION_REPLY, getBotSettings, GREETING_NOTICE } from "./bot-settings";
import { escalateConversation } from "./conversation-state";
import { logger } from "./logger";
import { sanitizePhone9Digits } from "./spreadsheet";

interface AssistantContext {
  phoneNumber: string;
  studentName: string | null;
  batch: "2027" | "2028" | "unknown";
  providerMessageId: string;
  /** Newline-joined text of the CURRENT burst only; entity extraction is bound to this. */
  turnText?: string;
}

const KNOWLEDGE_BASE_PATHS = [
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/knowledge-base.md"),
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "./knowledge-base.md"),
  path.resolve(process.cwd(), "artifacts/api-server/src/knowledge-base.md"),
  path.resolve(process.cwd(), "artifacts/api-server/dist/knowledge-base.md"),
  path.resolve(process.cwd(), "src/knowledge-base.md"),
];

let cachedKnowledgeBase: string | null = null;
let lastKbReadTime = 0;
const KB_CACHE_TTL_MS = 60_000;

export function getKnowledgeBasePath(): string {
  for (const candidate of KNOWLEDGE_BASE_PATHS) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return KNOWLEDGE_BASE_PATHS[0];
}

export function readKnowledgeBase(forceReload = false): string {
  const now = Date.now();
  if (!forceReload && cachedKnowledgeBase && now - lastKbReadTime < KB_CACHE_TTL_MS) {
    return cachedKnowledgeBase;
  }
  try {
    const kbPath = getKnowledgeBasePath();
    if (fs.existsSync(kbPath)) {
      cachedKnowledgeBase = fs.readFileSync(kbPath, "utf8");
      lastKbReadTime = now;
      return cachedKnowledgeBase;
    }
  } catch (err) {
    logger.warn({ err }, "Could not read knowledge-base.md, using fallback");
  }
  return (
    cachedKnowledgeBase ||
    `# Suranga Gamage A/L Media\nOfficial Hotline: 071 016 1699\nTechnical Support: 078 909 4047\nWebsite: mediasuranga.lk`
  );
}

export function writeKnowledgeBase(content: string): void {
  const targetPath = getKnowledgeBasePath();
  fs.writeFileSync(targetPath, content, "utf8");
  cachedKnowledgeBase = content;
  lastKbReadTime = Date.now();
  // Also sync across candidate locations if they exist
  for (const candidate of KNOWLEDGE_BASE_PATHS) {
    try {
      if (candidate !== targetPath && fs.existsSync(path.dirname(candidate))) {
        fs.writeFileSync(candidate, content, "utf8");
      }
    } catch {}
  }
}

export async function fetchDynamicAnnouncements(): Promise<string> {
  try {
    const items = await db
      .select()
      .from(dynamicContentTable)
      .orderBy(desc(dynamicContentTable.updatedAt));

    if (!items.length) return "";

    const formatted = items
      .map(
        (item) =>
          `📌 [${item.category.toUpperCase()}] **${item.title}**\n${item.content.trim()}`,
      )
      .join("\n\n");

    return `## 🚨 LATEST OFFICIAL ANNOUNCEMENTS & LIVE UPDATES (TOP PRIORITY)
These active announcements were published directly by class management and take strict precedence over any older or conflicting static guidelines:

${formatted}
`;
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "Could not load dynamic content from database",
    );
    return "";
  }
}

export async function buildSystemInstruction(settings?: BotSettings): Promise<string> {
  const botSettings = settings ?? (await getBotSettings());
  const dynamicAnnouncements = await fetchDynamicAnnouncements();
  const kb = readKnowledgeBase();

  const knowledgeSection = dynamicAnnouncements
    ? `${dynamicAnnouncements}\n\n---\n\n${kb}`
    : kb;

  // Persona/guidelines live in the database (bot_settings) so the dashboard can edit them live.
  return `${knowledgeSection}

---
${effectivePersona(botSettings)}`;
}

const FUNCTION_DECLARATIONS: FunctionDeclaration[] = [
  {
    name: "check_tute_delivery",
    description:
      "Look up tute / book dispatch records. Search ONLY by a phone number, name or tracking number that the student wrote in their CURRENT message. Never reuse details from earlier messages. If the student asks about their own number without typing one, call with no search fields.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        phone: { type: Type.STRING, description: "Sri Lankan phone number typed in the current message, if any." },
        name: { type: Type.STRING, description: "Student name typed in the current message, exactly as written (Sinhala or English), if any." },
        trackingNumber: { type: Type.STRING, description: "Tracking number typed in the current message, if any." },
        month: { type: Type.STRING, description: "Optional month in YYYY-MM format." },
        delivery_wave: { type: Type.STRING, enum: ["Wave 1", "Wave 2", "Wave 3", "Wave 4"], description: "Optional wave filter." },
        item_type: { type: Type.STRING, enum: ["Monthly Tute", "Special Book"], description: "Optional item filter." },
      },
    },
  },
  {
    name: "escalate_to_human",
    description:
      "Hand the conversation to the office staff and mute the bot. Use for actionable requests (payment slip verification, password reset, login errors, Zoom link requests), fee relief / free card requests, frustrated students, or questions that are not answered by the Knowledge Base.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        conversationId: { type: Type.STRING, description: "The current conversation id (phone number)." },
        reason: { type: Type.STRING, description: "Short reason for the office staff." },
      },
      required: ["reason"],
    },
  },
];

function monthNow(): string {
  return new Date().toISOString().slice(0, 7);
}

function stringArg(args: Record<string, unknown>, key: string, maxLength = 300): string {
  const value = args[key];
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function detectCourierService(trackingNumber: string): string {
  const clean = trackingNumber.trim().toUpperCase();
  if (
    clean.endsWith("LK") ||
    clean.startsWith("CP") ||
    clean.startsWith("PO") ||
    clean.startsWith("SLP")
  ) {
    return "Sri Lanka Post (ලංකා තැපැල් සේවය)";
  }
  if (clean.includes("PRX") || clean.includes("PROMPT") || clean.startsWith("PX")) {
    return "PromptX Courier";
  }
  if (clean.startsWith("DMX") || clean.includes("DOMEX")) {
    return "Domex Courier";
  }
  if (clean.startsWith("KMB") || clean.includes("KOOMBIYO")) {
    return "Koombiyo Delivery";
  }
  return "Sri Lanka Post / Registered Courier (ලියාපදිංචි තැපැල්)";
}

const SINHALA_CHAR = /[\u0D80-\u0DFF]/;

/**
 * Extracts a Sri Lankan mobile number from free text and returns its 9-digit core
 * (e.g. "+94 77 299 4218", "0772994218", "772994218" -> "772994218").
 */
export function extractSriLankanPhone(text: string): string | null {
  const match = text.match(/(?<!\d)(?:\+?94[\s-]?|0[\s-]?)?(7\d)[\s-]?(\d{3})[\s-]?(\d{4})(?!\d)/);
  return match ? `${match[1]}${match[2]}${match[3]}` : null;
}

/** Both stored/typed formats for a 9-digit core: 07XXXXXXXX and 947XXXXXXXX (plus bare / +94 forms). */
function phoneFormats(core: string): string[] {
  return [`0${core}`, `94${core}`, core, `+94${core}`];
}

const OWN_NUMBER_REQUEST =
  /(මගේ|mage|my)\s*(නම්බර්|නම්බරය|නම්බර|අංකය|අංකයට|number|no\b|nambar|num\b)/i;

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** Turns a Sinhala-script name into 2-3 phonetic English spellings using Gemini. */
async function transliterateName(client: GoogleGenAI, name: string): Promise<string[]> {
  try {
    const response = await generateContentWithFallback(client, {
      contents: [
        {
          role: "user",
          parts: [
            {
              text: `Transliterate this Sinhala personal name into 2 or 3 plausible English (Latin) spellings as they would appear in a Sri Lankan student register (e.g. "අවිශ්ක මලින්ද" -> ["Awishka Malinda","Avishka Malinda"]). Reply with ONLY a JSON array of strings.\n\nName: ${name}`,
            },
          ],
        },
      ],
      config: {
        systemInstruction: "You transliterate Sinhala names into English. Output strictly a JSON array of strings.",
        responseMimeType: "application/json",
        temperature: 0,
      },
    });
    const parsed: unknown = JSON.parse(response.text?.trim() || "[]");
    if (Array.isArray(parsed)) {
      return parsed
        .filter((v): v is string => typeof v === "string")
        .map((v) => v.replace(/[^A-Za-z\s.'-]/g, " ").replace(/\s+/g, " ").trim())
        .filter((v) => v.length >= 3)
        .slice(0, 3);
    }
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "Name transliteration failed");
  }
  return [];
}

async function nameConditions(client: GoogleGenAI, name: string) {
  const variants = SINHALA_CHAR.test(name) ? await transliterateName(client, name) : [name];
  const unique = [...new Set(variants.map((v) => v.replace(/[^A-Za-z\s.'-]/g, " ").replace(/\s+/g, " ").trim()))]
    .filter((v) => v.length >= 3);
  if (unique.length) {
    logger.info({ name, variants: unique }, "[Tute Search] Name variants");
  }
  const conditions = [];
  for (const variant of unique) {
    conditions.push(ilike(tuteDeliveriesTable.studentName, `%${escapeLike(variant)}%`));
    const tokens = variant.split(" ").filter((t) => t.length >= 3);
    if (tokens.length > 1) {
      conditions.push(
        and(...tokens.map((t) => ilike(tuteDeliveriesTable.studentName, `%${escapeLike(t)}%`))),
      );
    }
  }
  return conditions;
}

async function checkDelivery(
  client: GoogleGenAI,
  context: AssistantContext,
  args: Record<string, unknown>,
) {
  const turnText = context.turnText ?? "";
  const turnLower = turnText.toLowerCase();

  // Entity extraction is bound STRICTLY to the current turn (no sticky identity).
  let phoneCore = extractSriLankanPhone(turnText);
  if (!phoneCore) {
    const argPhone = extractSriLankanPhone(stringArg(args, "phone", 40));
    // Accept a model-supplied phone only if its digits really appear in the current message.
    if (argPhone && turnText.replace(/\D/g, "").includes(argPhone)) phoneCore = argPhone;
  }

  let name = stringArg(args, "name", 100);
  if (name && !(turnLower.includes(name.toLowerCase()) || SINHALA_CHAR.test(turnText))) name = "";
  // A phone number without a name queries ONLY by phone.
  if (phoneCore) name = "";

  let trackingNumber = stringArg(args, "trackingNumber", 60);
  if (trackingNumber && !turnLower.includes(trackingNumber.toLowerCase())) trackingNumber = "";

  let searchedBy: "phone" | "name" | "tracking" | "sender" | null = null;
  let identity;
  if (phoneCore) {
    searchedBy = "phone";
    identity = or(
      inArray(tuteDeliveriesTable.phoneNumber, phoneFormats(phoneCore)),
      sql`right(regexp_replace(${tuteDeliveriesTable.phoneNumber}, '\\D', '', 'g'), 9) = ${phoneCore}`,
    );
  } else if (trackingNumber) {
    searchedBy = "tracking";
    identity = sql`lower(${tuteDeliveriesTable.trackingNumber}) = ${trackingNumber.toLowerCase()}`;
  } else if (name) {
    searchedBy = "name";
    const conditions = await nameConditions(client, name);
    if (conditions.length) identity = or(...conditions);
  } else if (OWN_NUMBER_REQUEST.test(turnText)) {
    // The ONLY case where the sender's own number is used: explicit "my number" request.
    searchedBy = "sender";
    const core = sanitizePhone9Digits(context.phoneNumber);
    identity = or(
      inArray(tuteDeliveriesTable.phoneNumber, phoneFormats(core)),
      sql`right(regexp_replace(${tuteDeliveriesTable.phoneNumber}, '\\D', '', 'g'), 9) = ${core}`,
    );
  }

  if (!identity || !searchedBy) {
    return {
      found: false,
      needInfo: true,
      message:
        "Ask the student, in one short sentence, to send the phone number (or full name) the tute was registered with.",
    };
  }
  logger.info({ phone: context.phoneNumber, searchedBy, phoneCore }, "[Tute Search] Executing lookup");

  const requestedMonth = stringArg(args, "month", 7);
  const explicitMonth = /^\d{4}-\d{2}$/.test(requestedMonth) ? requestedMonth : null;
  const wave = stringArg(args, "delivery_wave", 20);
  const itemType = stringArg(args, "item_type", 40);
  const filters = [
    identity,
    ...(wave ? [eq(tuteDeliveriesTable.deliveryWave, wave)] : []),
    ...(itemType ? [eq(tuteDeliveriesTable.itemType, itemType)] : []),
  ];

  let month = explicitMonth ?? monthNow();
  let rows = await db
    .select()
    .from(tuteDeliveriesTable)
    .where(and(...filters, eq(tuteDeliveriesTable.month, month)))
    .orderBy(tuteDeliveriesTable.deliveryWave, tuteDeliveriesTable.itemType)
    .limit(20);

  if (!rows.length && !explicitMonth) {
    // Fall back to the most recent month that has records for this identity
    const [latest] = await db
      .select({ month: tuteDeliveriesTable.month })
      .from(tuteDeliveriesTable)
      .where(identity)
      .orderBy(desc(tuteDeliveriesTable.createdAt))
      .limit(1);
    if (latest?.month) {
      month = latest.month;
      rows = await db
        .select()
        .from(tuteDeliveriesTable)
        .where(and(...filters, eq(tuteDeliveriesTable.month, month)))
        .orderBy(tuteDeliveriesTable.deliveryWave, tuteDeliveriesTable.itemType)
        .limit(20);
    }
  }

  if (!rows.length) {
    return {
      found: false,
      month,
      message:
        "No delivery record exists for the details given. Tell the student briefly, and ask them to re-check the phone number. If they already retried, call escalate_to_human.",
    };
  }

  // A name can match several different students: never reveal parcels until the phone is confirmed.
  if (searchedBy === "name" && new Set(rows.map((r) => r.phoneNumber)).size > 1) {
    return {
      found: false,
      ambiguous: true,
      message:
        "Several students match this name. Ask the student, in one short sentence, to send the registered phone number instead.",
    };
  }

  return {
    found: true,
    month,
    searchedBy,
    records: rows.map((row) => ({
      itemType: row.itemType,
      deliveryWave: row.deliveryWave,
      trackingNumber: row.trackingNumber,
      courierService: detectCourierService(row.trackingNumber),
      deliveryStatus: row.status,
      dispatchedDate: row.createdAt ? new Date(row.createdAt).toLocaleDateString("en-CA") : "Dispatched",
      ...(searchedBy === "phone" || searchedBy === "sender" ? { address: row.address } : {}),
    })),
  };
}

interface ToolOutcome {
  result: Record<string, unknown>;
  escalated?: boolean;
}

async function executeTool(
  client: GoogleGenAI,
  name: string,
  args: Record<string, unknown>,
  context: AssistantContext,
): Promise<ToolOutcome> {
  if (name === "check_tute_delivery") {
    return { result: await checkDelivery(client, context, args) };
  }
  if (name === "escalate_to_human") {
    // The conversation id argument is ignored on purpose: only the current chat can be escalated.
    const reason = stringArg(args, "reason", 400) || "Unspecified";
    await escalateConversation(context.phoneNumber, reason);
    return { result: { escalated: true, reply: ESCALATION_REPLY }, escalated: true };
  }
  return { result: { error: `Tool ${name} is not supported.` } };
}

const CANDIDATE_MODELS = [
  process.env.GEMINI_MODEL,
  "gemini-3.5-flash-lite",
  "gemini-flash-lite-latest",
  "gemini-flash-latest",
  "gemini-3.5-flash",
  "gemini-3.7-flash",
  "gemini-3.8-flash",
  "gemini-3.1-flash-lite",
  "gemini-3.6-flash",
  "gemini-pro-latest",
].filter((m): m is string => Boolean(m));

interface GenerationConfig {
  systemInstruction: string;
  tools?: [{ functionDeclarations: FunctionDeclaration[] }];
  responseMimeType?: string;
  temperature?: number;
}

async function generateContentWithFallback(
  client: GoogleGenAI,
  req: { contents: Content[]; config: GenerationConfig },
) {
  let lastError: unknown;
  for (const model of CANDIDATE_MODELS) {
    try {
      return await client.models.generateContent({
        ...req,
        model,
      });
    } catch (err) {
      lastError = err;
      logger.warn(
        { model, err: err instanceof Error ? err.message : String(err) },
        "Gemini model attempt failed; trying fallback candidate",
      );
    }
  }
  throw lastError;
}

export async function generateStudentReply(
  context: AssistantContext,
): Promise<{ text: string; lastIntent: string }> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not configured");

  const history = await db
    .select({
      direction: conversationMessagesTable.direction,
      body: conversationMessagesTable.body,
      createdAt: conversationMessagesTable.createdAt,
    })
    .from(conversationMessagesTable)
    .where(
      and(
        eq(conversationMessagesTable.phoneNumber, context.phoneNumber),
        ne(conversationMessagesTable.deliveryStatus, "closed_silently"),
      ),
    )
    .orderBy(desc(conversationMessagesTable.createdAt))
    .limit(10);

  // Consecutive student messages (a debounced burst) become ONE consolidated user turn.
  const contents: Content[] = [];
  for (const message of history.reverse()) {
    const role = message.direction === "inbound" ? "user" : "model";
    const timeStr = message.createdAt.toISOString();
    const formattedText = `[${timeStr}] ${message.body}`;
    const last = contents[contents.length - 1];
    if (last && last.role === role) {
      last.parts = [{ text: `${last.parts?.[0]?.text ?? ""}\n${formattedText}` }];
    } else {
      contents.push({ role, parts: [{ text: formattedText }] });
    }
  }
  while (contents.length && contents[0].role !== "user") contents.shift();

  // The current burst (6s buffer) replaces the trailing user turn so it is one clean prompt.
  if (context.turnText) {
    const burst = { role: "user", parts: [{ text: context.turnText }] };
    if (contents.length && contents[contents.length - 1].role === "user") {
      contents[contents.length - 1] = burst;
    } else {
      contents.push(burst);
    }
  }
  if (!contents.length) {
    contents.push({ role: "user", parts: [{ text: "Hi" }] });
  }

  const client = new GoogleGenAI({ apiKey });
  const settings = await getBotSettings();
  const systemInstruction = await buildSystemInstruction(settings);
  const config: GenerationConfig = {
    systemInstruction,
    tools: [{ functionDeclarations: FUNCTION_DECLARATIONS }],
    temperature: settings.temperature,
  };

  let response = await generateContentWithFallback(client, { contents, config });

  let lastIntent = "general_inquiry";
  let escalated = false;
  for (let turn = 0; turn < 3; turn += 1) {
    const calls = response.functionCalls ?? [];
    if (!calls.length) break;

    const previousModelParts = response.candidates?.[0]?.content?.parts ?? [];
    contents.push({ role: "model", parts: previousModelParts as Part[] });
    const functionResponses: Part[] = [];

    for (const call of calls as FunctionCall[]) {
      const name = call.name ?? "";
      if (!name) continue;
      const args =
        call.args && typeof call.args === "object"
          ? (call.args as Record<string, unknown>)
          : {};
      lastIntent = name;
      try {
        const outcome = await executeTool(client, name, args, context);
        if (outcome.escalated) escalated = true;
        functionResponses.push({
          functionResponse: {
            name,
            ...(call.id ? { id: call.id } : {}),
            response: outcome.result,
          },
        });
      } catch (error) {
        logger.warn({ tool: name }, "Assistant tool execution failed");
        functionResponses.push({
          functionResponse: {
            name,
            ...(call.id ? { id: call.id } : {}),
            response: {
              error:
                error instanceof Error
                  ? error.message.slice(0, 240)
                  : "The requested information is temporarily unavailable.",
            },
          },
        });
      }
    }

    if (!functionResponses.length) break;
    // Once escalated the reply is fixed; no need for another model round-trip.
    if (escalated) break;
    contents.push({ role: "user", parts: functionResponses });
    response = await generateContentWithFallback(client, { contents, config });
  }

  if (escalated) return { text: ESCALATION_REPLY, lastIntent };

  let text = response.text?.trim() ?? "";
  if (
    /https?:\/\/[^\s]*zoom\.(us|com)\/[^\s]+/i.test(text) ||
    (/(zoom\.us|zoom\.com|zoom link|zoom password|zoom passcode|meeting id)/i.test(text) && /link|passcode|password/i.test(text))
  ) {
    logger.warn({ phone: context.phoneNumber }, "Sanitized accidental Zoom credentials in model output");
    await escalateConversation(context.phoneNumber, "Student requested a Zoom link / credentials");
    return { text: ESCALATION_REPLY, lastIntent: "escalate_to_human" };
  }
  if (!text) {
    logger.warn(
      { phone: context.phoneNumber },
      "Gemini returned empty reply text; using Meedi greeting fallback",
    );
    text = GREETING_NOTICE;
  }
  return { text, lastIntent };
}
