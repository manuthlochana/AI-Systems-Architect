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
import { and, desc, eq, ilike, or, sql } from "drizzle-orm";
import {
  conversationMessagesTable,
  conversationsTable,
  db,
  dynamicContentTable,
  tuteDeliveriesTable,
} from "@workspace/db";
import { logger } from "./logger";
import { sanitizePhone9Digits } from "./spreadsheet";

interface AssistantContext {
  phoneNumber: string;
  studentName: string | null;
  batch: "2027" | "2028" | "unknown";
  providerMessageId: string;
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

export async function buildSystemInstruction(): Promise<string> {
  const dynamicAnnouncements = await fetchDynamicAnnouncements();
  const kb = readKnowledgeBase();

  const knowledgeSection = dynamicAnnouncements
    ? `${dynamicAnnouncements}\n\n---\n\n${kb}`
    : kb;

  return `${knowledgeSection}

---
CRITICAL OPERATIONAL & PERSONA INSTRUCTIONS:
1. Strict Brevity & Concise Persona:
   - Keep EVERY reply strictly within 1 to 3 short sentences. Never output long essays, bullet point lists, or repetitive walls of text.
   - You are the caring, authentic, and professional Academic Coordinator for Suranga Gamage Sir's A/L Media classes at mediasuranga.lk.
   - Speak in natural, everyday conversational Sri Lankan Sinhala suitable for school students. Address the student warmly and lovingly as "පුතේ" or "දුවේ" (e.g., "ආයුබෝවන් පුතේ ✨", "තෙරුවන් සරණයි පුතේ 🌸", "ස්තූතියි පුතේ").
   - Anti-Repetition: Do NOT use identical robotic opening sentences in every message. Naturally vary greetings and phrasing.
   - Single Clarifying Question: When a student inquiry is ambiguous, vague, or missing crucial details (e.g. they ask about class without specifying 2027 or 2028 batch), ask ONE polite, concise clarifying question rather than guessing or dumping multi-paragraph explanations.

2. Contextual Emoji Tone:
   - Use emojis subtly and contextually (1 to 2 emojis per reply):
     📚 for notes and syllabus books.
     🎥 for Zoom sessions and recordings.
     📦🚚 for tute deliveries.
     🗓️ for schedules.
     ✨🌸 for warm greetings and blessings.

3. Strict Guardrails:
   - The bot exists STRICTLY for Suranga Gamage's A/L Media classes, admissions, timetables, tute parcels, website access, and A/L Media studies.
   - If a student asks questions about politics, other tuition teachers, general technology, gossip, or personal matters, politely redirect them back to class topics in 1 short sentence:
     "පුතේ, මට ඔබට උදව් කළ හැක්කේ අපගේ A/L Media පන්තියේ කටයුතු සම්බන්ධයෙන් පමණයි. 📚✨ පන්තියට අදාළව ඔබට ඇති ගැටලුව කුමක්දැයි පවසන්න."

4. Zero-Database Direct FAQ Answers:
   - For all general questions regarding timetables, class schedules, fees, night classes, website registration on mediasuranga.lk, and recording rules, ANSWER DIRECTLY from the Knowledge Base and Announcements above with ZERO database queries.

5. Strict Zoom Link Safety & Handoff ('request_zoom_link_handoff'):
   - UNDER NO CIRCUMSTANCES should you provide, invent, or share Zoom links, passwords, or meeting IDs.
   - When a student asks for a Zoom link or meeting credentials (e.g. "Zoom link eka denna", "link eka na", "ada class eke zoom link eka ko"):
     - IMMEDIATELY call the 'request_zoom_link_handoff' tool.
     - Respond ONLY with the warm official notice:
       "පුතේ, ආරක්ෂිත හේතූන් මත Zoom ලින්ක් එක කෙළින්ම මෙතනින් එවන්න බැහැ. අපේ Admin කෙනෙක් ඔයාගේ විස්තර පරීක්ෂා කරලා ඉක්මනින්ම ලින්ක් එක එවාවි. පොඩ්ඩක් රැඳී සිටින්න 🌸"

6. Tute Delivery Tool Usage ('check_tute_delivery'):
   - Call 'check_tute_delivery' ONLY when the student explicitly inquires about their tute dispatch, postal delivery, parcel tracking, or book dispatch.
   - If records are found: Report tracking number, courier service name (📦🚚), and delivery status in 1-2 brief sentences.
   - If no record is found: The tool handles administrative handoff automatically. Inform them warmly that staff will verify their parcel details.

7. Multi-message Bursts:
   - Treat consecutive short messages as a single inquiry and reply once briefly.`;
}

const FUNCTION_DECLARATIONS: FunctionDeclaration[] = [
  {
    name: "check_tute_delivery",
    description:
      "Look up this student's tute / book dispatch records and tracking numbers. Call ONLY when a student explicitly asks about tute delivery, parcel dispatch, or tracking number.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        month: { type: Type.STRING, description: "Optional month in YYYY-MM format." },
        student_name: { type: Type.STRING, description: "Optional student name if provided for fallback search." },
        address_or_district: { type: Type.STRING, description: "Optional address, town, or district for fallback search." },
        delivery_wave: { type: Type.STRING, enum: ["Wave 1", "Wave 2", "Wave 3", "Wave 4"], description: "Optional wave filter." },
        item_type: { type: Type.STRING, enum: ["Monthly Tute", "Special Book"], description: "Optional item filter." },
      },
    },
  },
  {
    name: "request_zoom_link_handoff",
    description:
      "Request administrative review and manual handoff when a student asks for a Zoom link or class meeting credentials. Never give Zoom links directly.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        reason: {
          type: Type.STRING,
          description: "Optional details about which class or link the student requested.",
        },
      },
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

async function checkDelivery(context: AssistantContext, args: Record<string, unknown>) {
  // Always the sender's own records; lookups use the uniform 9-digit phone key.
  const phoneKey = sanitizePhone9Digits(context.phoneNumber);
  const requestedMonth = stringArg(args, "month", 7);
  const explicitMonth = /^\d{4}-\d{2}$/.test(requestedMonth) ? requestedMonth : null;
  const wave = stringArg(args, "delivery_wave", 20);
  const itemType = stringArg(args, "item_type", 40);
  const studentNameArg = stringArg(args, "student_name", 100) || (context.studentName ?? "");
  const addressArg = stringArg(args, "address_or_district", 100);

  const phoneMatch = or(
    eq(tuteDeliveriesTable.phoneNumber, phoneKey),
    sql`right(regexp_replace(${tuteDeliveriesTable.phoneNumber}, '\\D', '', 'g'), 9) = ${phoneKey}`,
  );
  const filters = [
    phoneMatch,
    ...(wave ? [eq(tuteDeliveriesTable.deliveryWave, wave)] : []),
    ...(itemType ? [eq(tuteDeliveriesTable.itemType, itemType)] : []),
  ];

  let month = explicitMonth ?? monthNow();
  let rows = await db
    .select()
    .from(tuteDeliveriesTable)
    .where(and(...filters, eq(tuteDeliveriesTable.month, month)))
    .orderBy(tuteDeliveriesTable.deliveryWave, tuteDeliveriesTable.itemType);

  if (!rows.length && !explicitMonth) {
    // Fall back to student's most recent month with records
    const [latest] = await db
      .select({ month: tuteDeliveriesTable.month })
      .from(tuteDeliveriesTable)
      .where(phoneMatch)
      .orderBy(desc(tuteDeliveriesTable.createdAt))
      .limit(1);
    if (latest?.month) {
      month = latest.month;
      rows = await db
        .select()
        .from(tuteDeliveriesTable)
        .where(and(...filters, eq(tuteDeliveriesTable.month, month)))
        .orderBy(tuteDeliveriesTable.deliveryWave, tuteDeliveriesTable.itemType);
    }
  }

  // SECONDARY FALLBACK: Search by studentName or address if no records found by phone
  if (!rows.length && (studentNameArg.trim().length >= 3 || addressArg.trim().length >= 3)) {
    const fallbackConditions = [];
    if (studentNameArg.trim().length >= 3) {
      fallbackConditions.push(ilike(tuteDeliveriesTable.studentName, `%${studentNameArg.trim()}%`));
    }
    if (addressArg.trim().length >= 3) {
      fallbackConditions.push(ilike(tuteDeliveriesTable.address, `%${addressArg.trim()}%`));
    }

    if (fallbackConditions.length) {
      rows = await db
        .select()
        .from(tuteDeliveriesTable)
        .where(
          and(
            or(...fallbackConditions),
            ...(explicitMonth ? [eq(tuteDeliveriesTable.month, explicitMonth)] : []),
            ...(wave ? [eq(tuteDeliveriesTable.deliveryWave, wave)] : []),
            ...(itemType ? [eq(tuteDeliveriesTable.itemType, itemType)] : []),
          ),
        )
        .orderBy(desc(tuteDeliveriesTable.createdAt))
        .limit(5);

      if (rows.length) {
        logger.info(
          { phone: context.phoneNumber, studentName: studentNameArg, matches: rows.length },
          "[Tute Search Fallback] Found parcel record via secondary name/address search",
        );
      }
    }
  }

  if (!rows.length) {
    try {
      await db
        .update(conversationsTable)
        .set({ mode: "human" })
        .where(eq(conversationsTable.phoneNumber, context.phoneNumber));
      logger.info(
        { phone: context.phoneNumber },
        "[Tute Search Fallback] No parcel record found for student. Switched conversation mode to human.",
      );
    } catch (err) {
      logger.warn({ err, phone: context.phoneNumber }, "Failed to switch mode to human during tute fallback");
    }

    return {
      found: false,
      month,
      message:
        "පුතේ, ඔයාගේ නමට හෝ අංකයට අදාළව මේ මාසයේ ටියුට් පාර්සල් විස්තරයක් මෙතෙක් වාර්තා වී නැහැ. අපේ කාර්යාලයේ සම්බන්ධීකාරක කෙනෙක් ඔයාගේ ගෙවීම් විස්තර පරීක්ෂා කරලා ඉක්මනින්ම උදව් කරාවි 🌸",
    };
  }

  return {
    found: true,
    month,
    records: rows.map((row) => ({
      itemType: row.itemType,
      deliveryWave: row.deliveryWave,
      trackingNumber: row.trackingNumber,
      courierService: detectCourierService(row.trackingNumber),
      deliveryStatus: row.status,
      dispatchedDate: row.createdAt ? new Date(row.createdAt).toLocaleDateString("en-CA") : "Dispatched",
      address: row.address,
      reminder:
        "කරුණාකර ඔබගේ ළඟම ඇති තැපැල් කාර්යාලයෙන් හෝ බෙදාහැරීමේ සේවාවෙන් මෙම ලුහුබැඳීමේ අංකය (Tracking Number) ඉදිරිපත් කර විමසන්න.",
    })),
  };
}

async function executeTool(
  name: string,
  args: Record<string, unknown>,
  context: AssistantContext,
): Promise<Record<string, unknown>> {
  if (name === "check_tute_delivery") {
    return checkDelivery(context, args);
  }
  if (name === "request_zoom_link_handoff") {
    try {
      await db
        .update(conversationsTable)
        .set({ mode: "human" })
        .where(eq(conversationsTable.phoneNumber, context.phoneNumber));
      logger.info(
        { phone: context.phoneNumber, reason: args.reason },
        "[Zoom Handoff Requested] Switched conversation mode to human",
      );
    } catch (err) {
      logger.warn({ err, phone: context.phoneNumber }, "Failed to switch mode to human during Zoom handoff");
    }
    return {
      handoff: true,
      notice:
        "පුතේ, ආරක්ෂිත හේතූන් මත Zoom ලින්ක් එක කෙළින්ම මෙතනින් එවන්න බැහැ. අපේ Admin කෙනෙක් ඔයාගේ විස්තර පරීක්ෂා කරලා ඉක්මනින්ම ලින්ක් එක එවාවි. පොඩ්ඩක් රැඳී සිටින්න 🌸",
    };
  }
  return { error: `Tool ${name} is not supported.` };
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

async function generateContentWithFallback(
  client: GoogleGenAI,
  req: {
    contents: Content[];
    config: {
      systemInstruction: string;
      tools: [{ functionDeclarations: FunctionDeclaration[] }];
    };
  },
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
    .where(eq(conversationMessagesTable.phoneNumber, context.phoneNumber))
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
  if (!contents.length) {
    contents.push({ role: "user", parts: [{ text: "Hi" }] });
  }

  const client = new GoogleGenAI({ apiKey });
  const systemInstruction = await buildSystemInstruction();

  let response = await generateContentWithFallback(client, {
    contents,
    config: {
      systemInstruction,
      tools: [{ functionDeclarations: FUNCTION_DECLARATIONS }],
    },
  });

  let lastIntent = "general_inquiry";
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
        const result = await executeTool(name, args, context);
        functionResponses.push({
          functionResponse: {
            name,
            ...(call.id ? { id: call.id } : {}),
            response: result,
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
    contents.push({ role: "user", parts: functionResponses });
    response = await generateContentWithFallback(client, {
      contents,
      config: {
        systemInstruction,
        tools: [{ functionDeclarations: FUNCTION_DECLARATIONS }],
      },
    });
  }

  let text = response.text?.trim() ?? "";
  if (
    /https?:\/\/[^\s]*zoom\.(us|com)\/[^\s]+/i.test(text) ||
    (/(zoom\.us|zoom\.com|zoom link|zoom password|zoom passcode|meeting id)/i.test(text) && /link|passcode|password/i.test(text))
  ) {
    logger.warn({ phone: context.phoneNumber }, "Sanitized accidental Zoom credentials in model output");
    text =
      "පුතේ, ආරක්ෂිත හේතූන් මත Zoom ලින්ක් එක කෙළින්ම මෙතනින් එවන්න බැහැ. අපේ Admin කෙනෙක් ඔයාගේ විස්තර පරීක්ෂා කරලා ඉක්මනින්ම ලින්ක් එක එවාවි. පොඩ්ඩක් රැඳී සිටින්න 🌸";
  }
  if (!text) {
    logger.warn(
      { phone: context.phoneNumber },
      "Gemini returned empty reply text; using coordinator fallback message",
    );
    text =
      "ආයුබෝවන් පුතේ, මම සුරංග ගමගේ සර්ගේ A/L Media පන්ති සම්බන්ධීකාරක. ඔබට අවශ්‍ය පන්ති වේලාවන්, ටියුට් බෙදාහැරීම් හෝ පන්ති පිළිබඳ විස්තර මෙතැනින් විමසිය හැක. හදිසි විමසීම් සඳහා කාර්යාලය අමතන්න: 071 016 1699.";
  }
  return { text, lastIntent };
}
