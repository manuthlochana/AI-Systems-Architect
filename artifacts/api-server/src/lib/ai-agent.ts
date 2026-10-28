import {
  GoogleGenAI,
  Type,
  type Content,
  type FunctionCall,
  type FunctionDeclaration,
  type Part,
} from "@google/genai";
import { and, desc, eq } from "drizzle-orm";
import {
  conversationMessagesTable,
  conversationsTable,
  db,
  dynamicContentTable,
  recordingRequestsTable,
  tuteDeliveriesTable,
} from "@workspace/db";
import { logger } from "./logger";

const SYSTEM_INSTRUCTION = `You are the official, polite Sinhala-speaking Academic Coordinator for Suranga Gamage's A/L Media classes at mediasuranga.lk.
Speak naturally and respectfully in Sinhala. Warm openings may use "ආයුබෝවන් පුතේ" and closings may use "ස්තූතියි පුතේ".

Rules:
- Never invent fees, timetable details, delivery tracking information, dates, Zoom links, or passwords. Use the available tools for factual requests and clearly say when the database has no matching information.
- For tute delivery status or tracking numbers, always call check_tute_delivery.
- For timetables, class schedules, or fees, always call get_timetable_and_details.
- Explain that recordings are accessed through mediasuranga.lk after payment verification. For a specific class recording needed because of an issue, collect the requested date and class type, then call create_recording_request.
- If the student asks to speak with Sir personally about a study plan, or reports a site/password-reset technical problem, call escalate_to_human_agent. Explain that Sir can be reached after 5:00 PM at 071 016 1699; technical support is 078 909 4047.
- Never create or guess a Zoom password or URL. Do not claim staff have replied or that a recording is approved; recording requests remain pending until staff approve them.
- Do not ask the student to send sensitive account passwords or payment credentials.`;

const FUNCTION_DECLARATIONS: FunctionDeclaration[] = [
  {
    name: "check_tute_delivery",
    description: "Look up this student's tute tracking number and dispatch record.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        phone_number: { type: Type.STRING, description: "Student phone number, if known." },
        month: { type: Type.STRING, description: "Optional month in YYYY-MM format." },
      },
      required: ["phone_number"],
    },
  },
  {
    name: "get_timetable_and_details",
    description: "Retrieve published timetable and fee information for a student batch.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        batch: { type: Type.STRING, enum: ["2027", "2028", "unknown"] },
      },
      required: ["batch"],
    },
  },
  {
    name: "create_recording_request",
    description: "Create a pending staff review request for one class recording.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        phone_number: { type: Type.STRING },
        student_name: { type: Type.STRING },
        batch: { type: Type.STRING, enum: ["2027", "2028", "unknown"] },
        requested_date: { type: Type.STRING },
        class_type: { type: Type.STRING, enum: ["Theory", "Revision"] },
      },
      required: ["phone_number", "student_name", "batch", "requested_date", "class_type"],
    },
  },
  {
    name: "escalate_to_human_agent",
    description: "Put this student's conversation into the staff handoff queue.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        phone_number: { type: Type.STRING },
        reason: { type: Type.STRING },
      },
      required: ["phone_number", "reason"],
    },
  },
];

interface AssistantContext {
  phoneNumber: string;
  studentName: string | null;
  batch: "2027" | "2028" | "unknown";
  providerMessageId: string;
}

function monthNow(): string {
  return new Date().toISOString().slice(0, 7);
}

function stringArg(args: Record<string, unknown>, key: string, maxLength = 300): string {
  const value = args[key];
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

async function checkDelivery(context: AssistantContext, args: Record<string, unknown>) {
  const requestedMonth = stringArg(args, "month", 7);
  const month = /^\d{4}-\d{2}$/.test(requestedMonth) ? requestedMonth : monthNow();
  const [delivery] = await db
    .select()
    .from(tuteDeliveriesTable)
    .where(
      and(
        eq(tuteDeliveriesTable.phoneNumber, context.phoneNumber),
        eq(tuteDeliveriesTable.month, month),
      ),
    )
    .limit(1);
  if (!delivery) return { found: false, month };
  return {
    found: true,
    month: delivery.month,
    trackingNumber: delivery.trackingNumber,
    status: delivery.status,
    dispatchDate: delivery.createdAt.toISOString(),
  };
}

async function getTimetable(args: Record<string, unknown>) {
  const batch = stringArg(args, "batch", 20);
  if (!["2027", "2028", "unknown"].includes(batch)) {
    return { found: false, reason: "A supported batch was not provided." };
  }
  const keys =
    batch === "unknown"
      ? ["timetable_2027", "timetable_2028", "fees_info"]
      : [`timetable_${batch}`, "fees_info"];
  const entries = await db
    .select({
      key: dynamicContentTable.key,
      title: dynamicContentTable.title,
      content: dynamicContentTable.content,
      updatedAt: dynamicContentTable.updatedAt,
    })
    .from(dynamicContentTable)
    .where(
      and(
        eq(dynamicContentTable.category, "timetable"),
      ),
    )
    .orderBy(desc(dynamicContentTable.updatedAt));
  const pricingEntries = await db
    .select({
      key: dynamicContentTable.key,
      title: dynamicContentTable.title,
      content: dynamicContentTable.content,
      updatedAt: dynamicContentTable.updatedAt,
    })
    .from(dynamicContentTable)
    .where(eq(dynamicContentTable.category, "pricing"))
    .orderBy(desc(dynamicContentTable.updatedAt));
  const allEntries = [...entries, ...pricingEntries];
  const matching = keys
    .map((key) => allEntries.find((entry) => entry.key === key))
    .filter((entry) => entry !== undefined);
  return matching.length
    ? {
        found: true,
        entries: matching.map((entry) => ({
          ...entry,
          updatedAt: entry.updatedAt.toISOString(),
        })),
      }
    : { found: false, batch };
}

async function createRecordingRequest(
  context: AssistantContext,
  args: Record<string, unknown>,
) {
  const requestedDate = stringArg(args, "requested_date", 100);
  const classType = stringArg(args, "class_type", 20);
  const batchValue = stringArg(args, "batch", 20);
  if (
    !requestedDate ||
    (classType !== "Theory" && classType !== "Revision")
  ) {
    return { created: false, reason: "A valid class date and class type are required." };
  }
  const batch = (["2027", "2028", "unknown"].includes(batchValue)
    ? batchValue
    : context.batch) as AssistantContext["batch"];

  const [existing] = await db
    .select()
    .from(recordingRequestsTable)
    .where(eq(recordingRequestsTable.sourceMessageId, context.providerMessageId))
    .limit(1);
  if (existing) {
    return { created: true, status: existing.status, duplicate: true };
  }

  const [request] = await db
    .insert(recordingRequestsTable)
    .values({
      phoneNumber: context.phoneNumber,
      studentName: context.studentName || stringArg(args, "student_name", 120) || null,
      batch,
      requestedDate,
      classType,
      sourceMessageId: context.providerMessageId,
    })
    .onConflictDoNothing()
    .returning();
  if (!request) return { created: true, duplicate: true, status: "pending" };

  logger.info({ requestId: request.id }, "New recording request added to staff queue");
  return { created: true, status: request.status, confirmation: "Staff will verify payment and follow up." };
}

async function escalateToHuman(
  context: AssistantContext,
  args: Record<string, unknown>,
) {
  const reason = stringArg(args, "reason", 500) || "Student requested staff assistance";
  await db
    .update(conversationsTable)
    .set({ mode: "human", lastIntent: `human_handoff: ${reason}` })
    .where(eq(conversationsTable.phoneNumber, context.phoneNumber));
  logger.info("Conversation placed in staff handoff queue");
  return { escalated: true, queue: "human", message: "Conversation added to the staff handoff queue." };
}

async function executeTool(
  name: string,
  args: Record<string, unknown>,
  context: AssistantContext,
): Promise<Record<string, unknown>> {
  switch (name) {
    case "check_tute_delivery":
      return checkDelivery(context, args);
    case "get_timetable_and_details":
      return getTimetable(args);
    case "create_recording_request":
      return createRecordingRequest(context, args);
    case "escalate_to_human_agent":
      return escalateToHuman(context, args);
    default:
      return { error: "Unknown tool." };
  }
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
    })
    .from(conversationMessagesTable)
    .where(eq(conversationMessagesTable.phoneNumber, context.phoneNumber))
    .orderBy(desc(conversationMessagesTable.createdAt))
    .limit(12);
  const contents: Content[] = history.reverse().map((message) => ({
    role: message.direction === "inbound" ? "user" : "model",
    parts: [{ text: message.body }],
  }));

  const client = new GoogleGenAI({ apiKey });
  let response = await client.models.generateContent({
    model: "gemini-1.5-flash",
    contents,
    config: {
      systemInstruction: SYSTEM_INSTRUCTION,
      tools: [{ functionDeclarations: FUNCTION_DECLARATIONS }],
    },
  });

  let lastIntent = "general_question";
  for (let turn = 0; turn < 5; turn += 1) {
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
    response = await client.models.generateContent({
      model: "gemini-1.5-flash",
      contents,
      config: {
        systemInstruction: SYSTEM_INSTRUCTION,
        tools: [{ functionDeclarations: FUNCTION_DECLARATIONS }],
      },
    });
  }

  const text = response.text?.trim();
  if (!text) throw new Error("Gemini did not return a text response");
  return { text, lastIntent };
}
