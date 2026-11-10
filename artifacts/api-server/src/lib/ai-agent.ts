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
import { and, desc, eq, ne } from "drizzle-orm";
import {
  conversationMessagesTable,
  conversationsTable,
  db,
  dynamicContentTable,
  type BotSettings,
  type Conversation,
} from "@workspace/db";
import { effectivePersona, ESCALATION_REPLY, getBotSettings, GREETING_NOTICE } from "./bot-settings";
import { escalateConversation } from "./conversation-state";
import { logger } from "./logger";

export interface AssistantContext {
  phoneNumber: string;
  studentName: string | null;
  batch: "2027" | "2028" | "unknown";
  providerMessageId: string;
  /** Newline-joined text of the CURRENT burst only; entity extraction is bound to this. */
  turnText?: string;
}

export interface ReplyBubble {
  text: string;
  delayMs: number;
}

export interface StudentReplyResult {
  text: string;
  messages: ReplyBubble[];
  lastIntent: string;
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

function formatStudentProfileMemory(
  profile: Conversation | undefined,
  context: AssistantContext,
): string {
  const phone = profile?.phoneNumber ?? context.phoneNumber;
  const name = profile?.studentName ?? context.studentName ?? "Unknown";
  const gender = profile?.gender ?? "unknown";
  const examYear =
    profile?.examYear ||
    (profile?.batch && profile.batch !== "unknown" ? profile.batch : "Unknown");
  const district = profile?.hometownDistrict || "Unknown";
  const otherSubjects = profile?.otherSubjects || "Unknown";
  const classType = profile?.classType ?? "undecided";
  const physicalLocation = profile?.physicalLocation || "None";
  const onboardingStatus =
    profile?.onboardingStatus ??
    (profile?.studentType === "existing" ? "onboarded" : "new_lead");

  const statusGuidance =
    onboardingStatus === "onboarded"
      ? "EXISTING ENROLLED STUDENT (Academic Support & Care Mode): Do NOT ask onboarding/profiling questions and do NOT push registration or payment instructions unless the student explicitly asks about monthly fees."
      : `NEW / ONBOARDING STUDENT (${onboardingStatus}): Always answer the student's immediate question first. If natural, ask AT MOST ONE friendly follow-up question to discover missing fields (Exam Year -> District / Class Type). Once Exam Year and Class Type are known, guide them naturally on how to join.`;

  return `## 🧠 CURRENT STUDENT PROFILE MEMORY (PERMANENT DATABASE STATE)
Profile -> Phone: ${phone}, Name: ${name}, Gender: ${gender}, Exam: ${examYear}, District: ${district}, OtherSubjects: ${otherSubjects}, ClassType: ${classType}, PhysicalLocation: ${physicalLocation}, Status: ${onboardingStatus}

- Strict Memory Rule: NEVER re-ask a question for any field that already has a value above (e.g., if Exam is 2027 or District is known, never ask for it again).
- Mode Directive: ${statusGuidance}
- Whenever the student reveals any new or updated profile detail (exam year, district, online vs physical preference, physical center, gender, other subjects, or that they are already an enrolled student), call \`update_student_profile\`.`;
}

const BURST_OUTPUT_INSTRUCTION = `## 💬 MULTI-MESSAGE CONVERSATIONAL CADENCE (JSON OUTPUT FORMAT)
When sending your final reply to the student (after any tool calls), format your output as a JSON object with 1 to 3 short, natural WhatsApp message bubbles:
{"messages": [{"text": "First short message (1-2 friendly sentences).", "delayMs": 800}, {"text": "Optional second short message (e.g., a gentle follow-up question or link).", "delayMs": 1000}]}
- Each bubble MUST be 1–2 concise sentences in natural conversational Sinhala (or Singlish if they wrote in English).
- Use 1 bubble for simple direct answers, or 2–3 bubbles when answering a question AND asking one natural onboarding question or sharing a link.
- Set \`delayMs\` between 600 and 1200 for each bubble.`;

export async function buildSystemInstruction(
  settings?: BotSettings,
  studentProfile?: Conversation,
  context?: AssistantContext,
): Promise<string> {
  const botSettings = settings ?? (await getBotSettings());
  const dynamicAnnouncements = await fetchDynamicAnnouncements();
  const kb = readKnowledgeBase();

  const knowledgeSection = dynamicAnnouncements
    ? `${dynamicAnnouncements}\n\n---\n\n${kb}`
    : kb;

  const profileSection = context
    ? `\n\n---\n\n${formatStudentProfileMemory(studentProfile, context)}`
    : "";

  return `${knowledgeSection}

---
${effectivePersona(botSettings)}${profileSection}

---
${BURST_OUTPUT_INSTRUCTION}`;
}

const FUNCTION_DECLARATIONS: FunctionDeclaration[] = [
  {
    name: "update_student_profile",
    description:
      "Save or update discovered student profile attributes in permanent memory whenever the student mentions their A/L exam year, hometown/district, class preference (online vs physical), physical hall location, other A/L subjects, gender, or onboarding status.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        gender: {
          type: Type.STRING,
          enum: ["male", "female", "unknown"],
          description: "Inferred or stated student gender (male -> Malli, female -> Nangi).",
        },
        exam_year: {
          type: Type.STRING,
          description: "A/L exam year such as '2027' or '2028'.",
        },
        hometown_district: {
          type: Type.STRING,
          description: "Student's hometown or district in Sri Lanka (e.g., 'Matara', 'Galle', 'Hambantota', 'Colombo', 'Kandy', 'Kurunegala').",
        },
        other_subjects: {
          type: Type.STRING,
          description: "Comma-separated other A/L subjects the student studies (e.g., 'Sinhala, BC').",
        },
        class_type: {
          type: Type.STRING,
          enum: ["online", "physical", "undecided"],
          description: "Whether the student is attending online or physical hall classes.",
        },
        physical_location: {
          type: Type.STRING,
          enum: ["matara_sipyana", "tangalle_maarga", "galle_ics"],
          description: "Physical hall center if attending physical classes (Matara Sipyana, Tangalle Maarga, or Galle ICS).",
        },
        onboarding_status: {
          type: Type.STRING,
          enum: ["new_lead", "profiling", "payment_pending", "onboarded"],
          description: "Set to 'onboarded' if the student indicates they are already registered/paying, or 'payment_pending' once ready to register.",
        },
      },
    },
  },
  {
    name: "escalate_to_human",
    description:
      "Hand the conversation to the office staff and mute the bot. Use for actionable requests (payment slip verification, password reset, login errors, Zoom link requests), missing/delayed tute parcels, fee relief / free card requests, frustrated students, or questions that are not answered by the Knowledge Base.",
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

function stringArg(args: Record<string, unknown>, key: string, maxLength = 300): string {
  const value = args[key];
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

/**
 * Extracts a Sri Lankan mobile number from free text and returns its 9-digit core
 * (e.g. "+94 77 299 4218", "0772994218", "772994218" -> "772994218").
 */
export function extractSriLankanPhone(text: string): string | null {
  const match = text.match(/(?<!\d)(?:\+?94[\s-]?|0[\s-]?)?(7\d)[\s-]?(\d{3})[\s-]?(\d{4})(?!\d)/);
  return match ? `${match[1]}${match[2]}${match[3]}` : null;
}

const VALID_GENDERS = new Set(["male", "female", "unknown"]);
const VALID_CLASS_TYPES = new Set(["online", "physical", "undecided"]);
const VALID_LOCATIONS = new Set(["matara_sipyana", "tangalle_maarga", "galle_ics"]);
const VALID_STATUSES = new Set(["new_lead", "profiling", "payment_pending", "onboarded"]);

async function executeUpdateStudentProfile(
  context: AssistantContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const [existing] = await db
    .select()
    .from(conversationsTable)
    .where(eq(conversationsTable.phoneNumber, context.phoneNumber))
    .limit(1);

  const patch: Partial<typeof conversationsTable.$inferInsert> = {};

  const gender = stringArg(args, "gender", 20).toLowerCase();
  if (VALID_GENDERS.has(gender)) {
    patch.gender = gender as "male" | "female" | "unknown";
  }

  const examYearRaw = stringArg(args, "exam_year", 20) || (typeof args.exam_year === "number" ? String(args.exam_year) : "");
  if (examYearRaw) {
    const yearMatch = examYearRaw.match(/202[6-9]/);
    const parsedYear = Number.parseInt(yearMatch ? yearMatch[0] : examYearRaw, 10);
    if (Number.isFinite(parsedYear) && parsedYear >= 2025 && parsedYear <= 2032) {
      patch.examYear = parsedYear;
      if (parsedYear === 2027 || parsedYear === 2028) {
        patch.batch = String(parsedYear) as "2027" | "2028";
      }
    }
  }

  const district = stringArg(args, "hometown_district", 100);
  if (district) {
    patch.hometownDistrict = district;
  }

  const otherSubjects = stringArg(args, "other_subjects", 200);
  if (otherSubjects) {
    patch.otherSubjects = otherSubjects;
  }

  const classType = stringArg(args, "class_type", 30).toLowerCase();
  if (VALID_CLASS_TYPES.has(classType)) {
    patch.classType = classType as "online" | "physical" | "undecided";
  }

  const physicalLocation = stringArg(args, "physical_location", 40).toLowerCase();
  if (VALID_LOCATIONS.has(physicalLocation)) {
    patch.physicalLocation = physicalLocation as
      | "matara_sipyana"
      | "tangalle_maarga"
      | "galle_ics";
    if (!patch.classType) {
      patch.classType = "physical";
    }
  }

  const explicitStatus = stringArg(args, "onboarding_status", 30).toLowerCase();
  if (VALID_STATUSES.has(explicitStatus)) {
    patch.onboardingStatus = explicitStatus as
      | "new_lead"
      | "profiling"
      | "payment_pending"
      | "onboarded";
  } else if (existing?.onboardingStatus !== "onboarded") {
    const mergedExamYear = patch.examYear ?? existing?.examYear;
    const mergedClassType = patch.classType ?? existing?.classType ?? "undecided";
    if (mergedExamYear && mergedClassType !== "undecided") {
      patch.onboardingStatus = "payment_pending";
    } else if (
      mergedExamYear ||
      patch.hometownDistrict ||
      existing?.hometownDistrict ||
      mergedClassType !== "undecided"
    ) {
      patch.onboardingStatus = "profiling";
    }
  }

  if (patch.onboardingStatus === "onboarded") {
    patch.studentType = "existing";
  }

  if (Object.keys(patch).length > 0) {
    await db
      .update(conversationsTable)
      .set(patch)
      .where(eq(conversationsTable.phoneNumber, context.phoneNumber));
    logger.info(
      { phone: context.phoneNumber, updatedFields: patch },
      "[Student Profile] Updated permanent student profile memory",
    );
  }

  return {
    updated: true,
    profile: {
      gender: patch.gender ?? existing?.gender ?? "unknown",
      examYear: patch.examYear ?? existing?.examYear ?? null,
      hometownDistrict: patch.hometownDistrict ?? existing?.hometownDistrict ?? null,
      otherSubjects: patch.otherSubjects ?? existing?.otherSubjects ?? null,
      classType: patch.classType ?? existing?.classType ?? "undecided",
      physicalLocation: patch.physicalLocation ?? existing?.physicalLocation ?? null,
      onboardingStatus: patch.onboardingStatus ?? existing?.onboardingStatus ?? "new_lead",
    },
  };
}

interface ToolOutcome {
  result: Record<string, unknown>;
  escalated?: boolean;
}

async function executeTool(
  name: string,
  args: Record<string, unknown>,
  context: AssistantContext,
): Promise<ToolOutcome> {
  if (name === "update_student_profile") {
    return { result: await executeUpdateStudentProfile(context, args) };
  }
  if (name === "escalate_to_human") {
    // The conversation id argument is ignored on purpose: only the current chat can be escalated.
    const reason = stringArg(args, "reason", 400) || "Unspecified";
    await escalateConversation(context.phoneNumber, reason);
    return { result: { escalated: true, reply: ESCALATION_REPLY }, escalated: true };
  }
  return { result: { error: `Tool ${name} is not supported.` } };
}

function clampDelayMs(value: unknown, textLength = 60): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(600, Math.min(1200, Math.round(value)));
  }
  const estimated = 600 + Math.min(600, Math.round(textLength * 4));
  return Math.max(600, Math.min(1200, estimated));
}

export function parseReplyBubbles(rawText: string): ReplyBubble[] {
  const trimmed = rawText.trim();
  if (!trimmed) {
    return [{ text: GREETING_NOTICE, delayMs: 800 }];
  }

  // Strip optional markdown code fences around JSON
  const fenceStripped = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  const jsonMatch = fenceStripped.match(/\{[\s\S]*"messages"\s*:\s*\[[\s\S]*\][\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed: unknown = JSON.parse(jsonMatch[0]);
      if (
        parsed &&
        typeof parsed === "object" &&
        "messages" in parsed &&
        Array.isArray((parsed as { messages: unknown }).messages)
      ) {
        const rawMessages = (parsed as { messages: unknown[] }).messages;
        const bubbles: ReplyBubble[] = [];
        for (const item of rawMessages) {
          if (item && typeof item === "object" && "text" in item) {
            const text = String((item as { text: unknown }).text ?? "").trim();
            if (text) {
              bubbles.push({
                text,
                delayMs: clampDelayMs(
                  (item as { delayMs?: unknown }).delayMs,
                  text.length,
                ),
              });
            }
          } else if (typeof item === "string" && item.trim()) {
            const text = item.trim();
            bubbles.push({ text, delayMs: clampDelayMs(undefined, text.length) });
          }
        }
        if (bubbles.length > 0) {
          return bubbles.slice(0, 4);
        }
      }
    } catch {
      // Fall through to natural paragraph splitting
    }
  }

  // Fallback: split multi-paragraph plain text into 1-3 natural bubbles
  const paragraphs = fenceStripped
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);

  if (paragraphs.length > 1) {
    return paragraphs.slice(0, 3).map((text) => ({
      text,
      delayMs: clampDelayMs(undefined, text.length),
    }));
  }

  return [{ text: fenceStripped, delayMs: clampDelayMs(undefined, fenceStripped.length) }];
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
): Promise<StudentReplyResult> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not configured");

  const [[studentProfile], history] = await Promise.all([
    db
      .select()
      .from(conversationsTable)
      .where(eq(conversationsTable.phoneNumber, context.phoneNumber))
      .limit(1),
    db
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
      .limit(12),
  ]);

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
  const systemInstruction = await buildSystemInstruction(settings, studentProfile, context);
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
        const outcome = await executeTool(name, args, context);
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

  if (escalated) {
    return {
      text: ESCALATION_REPLY,
      messages: [{ text: ESCALATION_REPLY, delayMs: 800 }],
      lastIntent,
    };
  }

  const rawText = response.text?.trim() ?? "";
  const bubbles = parseReplyBubbles(rawText);
  const combinedText = bubbles.map((b) => b.text).join("\n\n");

  if (
    /https?:\/\/[^\s]*zoom\.(us|com)\/(?:j|my|wc)\/[^\s]+/i.test(combinedText) ||
    (/(zoom\.us|zoom\.com|zoom link|zoom password|zoom passcode|meeting id)/i.test(combinedText) &&
      /passcode|password|meeting id/i.test(combinedText))
  ) {
    logger.warn({ phone: context.phoneNumber }, "Sanitized accidental Zoom credentials in model output");
    await escalateConversation(context.phoneNumber, "Student requested a Zoom link / credentials");
    return {
      text: ESCALATION_REPLY,
      messages: [{ text: ESCALATION_REPLY, delayMs: 800 }],
      lastIntent: "escalate_to_human",
    };
  }

  return {
    text: combinedText,
    messages: bubbles,
    lastIntent,
  };
}
