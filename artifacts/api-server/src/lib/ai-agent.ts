import {
  GoogleGenAI,
  Type,
  type Content,
  type FunctionCall,
  type FunctionDeclaration,
  type Part,
} from "@google/genai";
import { and, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import {
  conversationMessagesTable,
  conversationsTable,
  db,
  dynamicContentTable,
  recordingRequestsTable,
  tuteDeliveriesTable,
} from "@workspace/db";
import { logger } from "./logger";
import { toPhoneKey } from "./spreadsheet";

const SYSTEM_INSTRUCTION = `You are the official, polite Sinhala-speaking Academic Coordinator for Suranga Gamage's A/L Media classes at mediasuranga.lk.
Speak naturally and respectfully in Sinhala. Warm openings may use "ආයුබෝවන් පුතේ" and closings may use "ස්තූතියි පුතේ". Always stay in this persona: you are Suranga Gamage's academic coordinator, never a generic chatbot.
Students write in Sinhala, English, or "Singlish" (Sinhala typed in English letters). Understand it and reply in clear, simple Sinhala (you may mirror a student who writes in English).

Singlish vocabulary used by A/L students (interpret, do not repeat back unless useful):
- "clz", "class", "klaasa", "clas eka" = class / the class
- "tut awe na", "tute awe na", "tute ekak awe na", "tute eka thama na" = the tute has not arrived -> check_tute_delivery
- "tute eka giya da", "tracking number eka", "post eka" = asking for tute dispatch/tracking
- "slip upload", "slip eka danna", "slip eka yawwa" = uploading/sending the payment slip
- "bank deposit", "deposit kala", "bank eke damma" = paid by bank deposit
- "salli damma", "salli dunna", "gevva" = I have paid
- "recoding locked", "recording lock", "recording open wenne na", "recording eka balanna ba" = recording is locked / cannot be viewed
- "recording eka", "rec eka", "zoom eka miss una", "clz eka miss una" = wants a past class recording
- "link eka denna", "zoom link", "revision link" = asking for a link
- "password eka", "login wenne na", "site eka open wenne na" = website/login problem
- "mage batch eka", "2027 theory", "2027 revision", "2028 night class" = class and batch names
- "sir", "sir ta kiyanna" = the student wants Sir / staff
- "monthly tute", "wave 1/2/3/4", "special book", "paper pack" = delivery items and waves

Rules:
- Never invent fees, timetable details, delivery tracking information, dates, Zoom links, or passwords. Use the available tools for factual requests and clearly say when the database has no matching information.
- For tute or book delivery status or tracking numbers, always call check_tute_delivery. Report each item (Monthly Tute / Special Book), its delivery wave, and its postal tracking number exactly as returned.
- For timetables, class schedules, or fees, always call get_timetable_and_details.
- For FAQs, announcements, notices, or any general class information question that is not a timetable or fee, call get_dynamic_content (pass the student's keywords as the query) before answering. Answer only from what it returns.
- Recordings are accessed through mediasuranga.lk after payment verification. NEVER send, paste, or invent a Zoom link for a past class, and never promise one automatically.
- When a student asks for a class recording, politely collect ALL FOUR details before doing anything else (ask for the missing ones, a few at a time): (1) Class and batch (e.g. 2027 Theory, 2027 Revision, 2028 Night Class), (2) the date of the class they need, (3) whether they are an Online or Physical student, and (4) the reason they need the recording. Once all four are answered, call create_recording_request. Then tell the student that staff will review the request and send the link via WhatsApp after approval. Do not say it is approved.
- If the student asks to speak with Sir personally about a study plan, or reports a site/password-reset technical problem, call escalate_to_human_agent. Explain that Sir can be reached after 5:00 PM at 071 016 1699; technical support is 078 909 4047.
- Never create or guess a Zoom password or URL. Do not claim staff have replied or that a recording is approved; recording requests remain pending until staff approve them.
- Several short messages may arrive together (for example "Hi", "Sir", "2027 revision link eka denna"). Treat them as one request and answer once.
- Do not ask the student to send sensitive account passwords or payment credentials.`;

const FUNCTION_DECLARATIONS: FunctionDeclaration[] = [
  {
    name: "check_tute_delivery",
    description:
      "Look up this student's tute / book dispatch records. Returns every matching item with its delivery wave, item type and postal tracking number.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        phone_number: { type: Type.STRING, description: "Student phone number, if known." },
        month: { type: Type.STRING, description: "Optional month in YYYY-MM format." },
        delivery_wave: { type: Type.STRING, enum: ["Wave 1", "Wave 2", "Wave 3", "Wave 4"], description: "Optional wave filter." },
        item_type: { type: Type.STRING, enum: ["Monthly Tute", "Special Book"], description: "Optional item filter." },
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
    description:
      "Create a pending staff review ticket for one class recording. Call only after the student has given class & batch, date, Online/Physical status and reason.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        phone_number: { type: Type.STRING },
        student_name: { type: Type.STRING },
        class_name: { type: Type.STRING, description: "Class and batch, e.g. '2027 Theory', '2027 Revision', '2028 Night Class'." },
        requested_date: { type: Type.STRING, description: "Date of the class the student needs." },
        student_type: { type: Type.STRING, enum: ["Online", "Physical", "Unknown"] },
        reason: { type: Type.STRING, description: "Why the student needs the recording." },
      },
      required: ["class_name", "requested_date", "student_type", "reason"],
    },
  },
  {
    name: "get_dynamic_content",
    description:
      "Read admin-managed FAQs, announcements and general class information from the knowledge base.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        category: { type: Type.STRING, enum: ["faq", "announcement", "general", "all"], description: "Which kind of entry to read." },
        query: { type: Type.STRING, description: "Optional keywords from the student's question." },
      },
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
    // Nothing this month: fall back to the student's most recent month with records.
    const [latest] = await db
      .select({ month: tuteDeliveriesTable.month })
      .from(tuteDeliveriesTable)
      .where(and(...filters))
      .orderBy(desc(tuteDeliveriesTable.month))
      .limit(1);
    if (latest) {
      month = latest.month;
      rows = await db
        .select()
        .from(tuteDeliveriesTable)
        .where(and(...filters, eq(tuteDeliveriesTable.month, month)))
        .orderBy(tuteDeliveriesTable.deliveryWave, tuteDeliveriesTable.itemType);
    }
  }
  if (!rows.length) return { found: false, month };
  return {
    found: true,
    month,
    deliveries: rows.map((delivery) => ({
      item: delivery.itemType,
      wave: delivery.deliveryWave,
      trackingNumber: delivery.trackingNumber,
      status: delivery.status,
      dispatchDate: delivery.createdAt.toISOString(),
    })),
  };
}

async function getDynamicContent(args: Record<string, unknown>) {
  const category = stringArg(args, "category", 20);
  const terms = stringArg(args, "query", 200)
    .split(/\s+/)
    .map((term) => term.replace(/[%_\\]/g, ""))
    .filter((term) => term.length >= 2)
    .slice(0, 6);
  const categories = (
    ["faq", "announcement", "general"].includes(category)
      ? [category]
      : ["faq", "announcement", "general"]
  ) as Array<"faq" | "announcement" | "general">;

  const matchesTerms = terms.length
    ? or(
        ...terms.flatMap((term) => [
          ilike(dynamicContentTable.title, `%${term}%`),
          ilike(dynamicContentTable.content, `%${term}%`),
          ilike(dynamicContentTable.key, `%${term}%`),
        ]),
      )
    : undefined;
  const select = () =>
    db
      .select()
      .from(dynamicContentTable)
      .where(and(inArray(dynamicContentTable.category, categories), matchesTerms))
      .orderBy(desc(dynamicContentTable.updatedAt))
      .limit(8);

  let rows = await select();
  let matchedByKeywords = terms.length > 0;
  if (!rows.length && terms.length) {
    // No keyword hit: return the latest entries so the model can judge relevance itself.
    rows = await db
      .select()
      .from(dynamicContentTable)
      .where(inArray(dynamicContentTable.category, categories))
      .orderBy(desc(dynamicContentTable.updatedAt))
      .limit(8);
    matchedByKeywords = false;
  }
  if (!rows.length) return { found: false };
  return {
    found: true,
    matchedByKeywords,
    entries: rows.map((row) => ({
      category: row.category,
      title: row.title,
      content: row.content.slice(0, 2500),
      updatedAt: row.updatedAt.toISOString(),
    })),
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
  const className = stringArg(args, "class_name", 120);
  const requestedDate = stringArg(args, "requested_date", 100);
  const reason = stringArg(args, "reason", 500);
  const studentTypeValue = stringArg(args, "student_type", 20);
  const studentType = (["Online", "Physical", "Unknown"].includes(studentTypeValue)
    ? studentTypeValue
    : "Unknown") as "Online" | "Physical" | "Unknown";
  if (!className || !requestedDate || !reason || studentType === "Unknown") {
    return {
      created: false,
      reason:
        "Class & batch, date, Online/Physical status and reason are all required. Ask the student for the missing details.",
    };
  }

  const classType = /revision/i.test(className)
    ? ("Revision" as const)
    : /theory/i.test(className)
      ? ("Theory" as const)
      : null;
  const batchMatch = /(2027|2028)/.exec(className);
  const batch = (batchMatch?.[1] ?? context.batch) as AssistantContext["batch"];

  const [existing] = await db
    .select()
    .from(recordingRequestsTable)
    .where(eq(recordingRequestsTable.sourceMessageId, context.providerMessageId))
    .limit(1);
  if (existing) {
    return { created: true, status: existing.status, duplicate: true };
  }

  // Last 3-4 student messages so staff can review the conversation behind the ticket.
  const recentInbound = await db
    .select({ body: conversationMessagesTable.body })
    .from(conversationMessagesTable)
    .where(
      and(
        eq(conversationMessagesTable.phoneNumber, context.phoneNumber),
        eq(conversationMessagesTable.direction, "inbound"),
      ),
    )
    .orderBy(desc(conversationMessagesTable.createdAt))
    .limit(4);
  const lastChatContext = recentInbound
    .reverse()
    .map((message) => message.body)
    .join("\n")
    .slice(0, 2000);

  const [request] = await db
    .insert(recordingRequestsTable)
    .values({
      phoneNumber: context.phoneNumber,
      studentName: context.studentName || stringArg(args, "student_name", 120) || null,
      batch,
      requestedDate,
      classType,
      className,
      studentType,
      reason,
      lastChatContext,
      sourceMessageId: context.providerMessageId,
    })
    .onConflictDoNothing()
    .returning();
  if (!request) return { created: true, duplicate: true, status: "pending" };

  logger.info({ requestId: request.id }, "New recording request added to staff queue");
  return {
    created: true,
    status: request.status,
    confirmation:
      "Pending ticket saved. Staff will review it and send the link via WhatsApp after approval.",
  };
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
    case "get_dynamic_content":
      return getDynamicContent(args);
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
    .limit(20);
  // Consecutive student messages (a debounced burst) become ONE consolidated user turn.
  const contents: Content[] = [];
  for (const message of history.reverse()) {
    const role = message.direction === "inbound" ? "user" : "model";
    const last = contents[contents.length - 1];
    if (last && last.role === role) {
      last.parts = [{ text: `${last.parts?.[0]?.text ?? ""}\n${message.body}` }];
    } else {
      contents.push({ role, parts: [{ text: message.body }] });
    }
  }
  while (contents.length && contents[0].role !== "user") contents.shift();

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
