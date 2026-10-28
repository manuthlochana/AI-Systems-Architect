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
import { and, desc, eq, sql } from "drizzle-orm";
import {
  conversationMessagesTable,
  conversationsTable,
  db,
  tuteDeliveriesTable,
} from "@workspace/db";
import { logger } from "./logger";
import { toPhoneKey } from "./spreadsheet";

interface AssistantContext {
  phoneNumber: string;
  studentName: string | null;
  batch: "2027" | "2028" | "unknown";
  providerMessageId: string;
}

const KNOWLEDGE_BASE_PATHS = [
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../knowledge-base.md"),
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "./knowledge-base.md"),
  path.resolve(process.cwd(), "artifacts/api-server/src/knowledge-base.md"),
  path.resolve(process.cwd(), "artifacts/api-server/dist/knowledge-base.md"),
  path.resolve(process.cwd(), "src/knowledge-base.md"),
  path.resolve(process.cwd(), "knowledge-base.md"),
];

export function getKnowledgeBasePath(): string {
  for (const candidate of KNOWLEDGE_BASE_PATHS) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return KNOWLEDGE_BASE_PATHS[0];
}

export function readKnowledgeBase(): string {
  try {
    const kbPath = getKnowledgeBasePath();
    if (fs.existsSync(kbPath)) {
      return fs.readFileSync(kbPath, "utf8");
    }
  } catch (err) {
    logger.warn({ err }, "Could not read knowledge-base.md, using fallback");
  }
  return `# Suranga Gamage A/L Media
Official Hotline: 071 016 1699
Technical Support: 078 909 4047
Website: mediasuranga.lk`;
}

export function writeKnowledgeBase(content: string): void {
  const targetPath = getKnowledgeBasePath();
  fs.writeFileSync(targetPath, content, "utf8");
  // Also sync across candidate locations if they exist
  for (const candidate of KNOWLEDGE_BASE_PATHS) {
    try {
      if (candidate !== targetPath && fs.existsSync(path.dirname(candidate))) {
        fs.writeFileSync(candidate, content, "utf8");
      }
    } catch {}
  }
}

export function buildSystemInstruction(): string {
  const kb = readKnowledgeBase();
  return `${kb}

---
CRITICAL OPERATIONAL INSTRUCTIONS:
1. Persona & Tone: You are the official, polite Sinhala-speaking Academic Coordinator for Suranga Gamage's A/L Media classes at mediasuranga.lk. Always speak warmly and respectfully in Sinhala ("ආයුබෝවන් පුතේ", "ස්තූතියි පුතේ"). Never act as a generic AI chatbot.
2. Short-Term Memory Context: Always maintain the context of the recent messages above. If the student asks a follow-up question (e.g. 'හෙටත් එහෙමද?', 'කීයටද?', 'ගාස්තුව කීයද?'), refer directly to the previously discussed topic.
3. Zero-Database Knowledge Direct Answers: For all general questions regarding timetables, class schedules, fees, night classes, Zoom rules, website registration on mediasuranga.lk, and recording access rules, ANSWER DIRECTLY AND EXCLUSIVELY from the Knowledge Base above with NO tool calls or database queries.
4. Tute Delivery Tool Usage: Call 'check_tute_delivery' ONLY when the student explicitly inquires about tute/book delivery dispatch, parcel arrival, or tracking numbers.
   - If records are found, report the items, delivery waves, and postal tracking numbers clearly.
   - If no records are found or found is false, provide a polite Sinhala notice explaining that no record was found for this phone number, and direct them to contact the office on 071 016 1699.
5. Zoom & Recording Safety: Never generate, invent, or share Zoom links or passwords directly. Class sessions and recordings are accessed strictly through mediasuranga.lk after payment approval.
6. Multi-message Bursts: Several short student messages may arrive together (e.g., "Hi", "Sir", "2027 timetable"). Treat them as a single consolidated inquiry and respond once.`;
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
        delivery_wave: { type: Type.STRING, enum: ["Wave 1", "Wave 2", "Wave 3", "Wave 4"], description: "Optional wave filter." },
        item_type: { type: Type.STRING, enum: ["Monthly Tute", "Special Book"], description: "Optional item filter." },
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

async function checkDelivery(context: AssistantContext, args: Record<string, unknown>) {
  // Always the sender's own records; lookups use the uniform 9-digit phone key.
  const phoneKey = toPhoneKey(context.phoneNumber);
  const requestedMonth = stringArg(args, "month", 7);
  const explicitMonth = /^\d{4}-\d{2}$/.test(requestedMonth) ? requestedMonth : null;
  const wave = stringArg(args, "delivery_wave", 20);
  const itemType = stringArg(args, "item_type", 40);
  const phoneMatch = sql`right(regexp_replace(${tuteDeliveriesTable.phoneNumber}, '\\D', '', 'g'), 9) = ${phoneKey}`;
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

  if (!rows.length) {
    return {
      found: false,
      month,
      message:
        "No delivery record was found for this phone number. Ask the student to contact the office on 071 016 1699.",
    };
  }

  return {
    found: true,
    month,
    records: rows.map((row) => ({
      itemType: row.itemType,
      deliveryWave: row.deliveryWave,
      trackingNumber: row.trackingNumber,
      status: row.status,
      address: row.address,
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
  return { error: `Tool ${name} is not supported.` };
}

const CANDIDATE_MODELS = [
  process.env.GEMINI_MODEL,
  "gemini-3.5-flash",
  "gemini-3.5-flash-lite",
  "gemini-3.6-flash",
  "gemini-flash-latest",
  "gemini-3.8-flash",
  "gemini-2.5-flash-lite",
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
  const systemInstruction = buildSystemInstruction();

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
