import { GoogleGenAI, type Content } from "@google/genai";
import { and, desc, eq, gte } from "drizzle-orm";
import {
  conversationMessagesTable,
  db,
  dynamicContentTable,
  suggestedKnowledgeItemsTable,
} from "@workspace/db";
import { readKnowledgeBase } from "./ai-agent";
import { logger } from "./logger";

const CANDIDATE_MODELS = [
  process.env.GEMINI_MODEL,
  "gemini-3.5-flash-lite",
  "gemini-flash-lite-latest",
  "gemini-flash-latest",
  "gemini-3.5-flash",
].filter((m): m is string => Boolean(m));

/** Scrubs Sri Lankan phone numbers, emails, and image tags from raw text before LLM reflection. */
export function scrubRawPii(text: string): string {
  return text
    .replace(/\[IMAGE:[^\]]+\]/g, "[Image Attachment]")
    .replace(/(?<!\d)(?:\+?94[\s-]?|0[\s-]?)?7\d[\s-]?\d{3}[\s-]?\d{4}(?!\d)/g, "[PHONE_REDACTED]")
    .replace(/\b\d{9}[VvXx]\b|\b\d{12}\b/g, "[NIC_REDACTED]")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[EMAIL_REDACTED]")
    .trim();
}

interface DistilledKnowledgeItem {
  valuable: boolean;
  confidence: number;
  category: "faq" | "timetable" | "pricing" | "general" | "announcement";
  generalizedQuestion: string;
  generalizedAnswer: string;
}

const REFLECTION_SYSTEM_PROMPT = `You are the Cognitive Memory Reflection Engine for Suranga Gamage's A/L Media Class Office (mediasuranga.lk).
Your job is to analyze human-staff intervention chats and extract ONLY globally reusable class policies, schedule updates, or recurring FAQs that are not already obvious, while strictly stripping all Personal Identifiable Information (PII).

STRICT FILTERING & PRIVACY RULES:
1. STRIP ALL PII: Never include any student name, phone number, NIC number, home address, bank slip number, or parcel tracking code in your output.
2. REJECT ONE-OFF / PERSONAL TRANSACTIONS (set "valuable": false):
   - Password reset confirmations (e.g., "Your password was reset to 12345678")
   - Individual payment slip approvals ("Your slip is verified")
   - Individual tute tracking lookups
   - Casual greetings, acknowledgements, or "wait a moment" messages
   - Anything specific to only one student's personal account
3. EXTRACT ONLY REUSABLE GLOBAL KNOWLEDGE (set "valuable": true, "confidence": 0.75 to 1.0):
   - New or clarified class schedules, date changes, special seminars, or paper class times
   - General policies about tutes, recordings, regional rules, or fees that apply to all students
   - Clear answers to recurring academic or registration questions
4. Write both "generalizedQuestion" and "generalizedAnswer" in clear, natural Sinhala suitable for the official FAQ Knowledge Base.

Return STRICT JSON matching this schema:
{
  "items": [
    {
      "valuable": true,
      "confidence": 0.9,
      "category": "faq",
      "generalizedQuestion": "Generalized student question in Sinhala (zero PII)",
      "generalizedAnswer": "Clean, authoritative office answer in Sinhala (zero PII)"
    }
  ]
}`;

async function runGeminiReflection(promptText: string): Promise<DistilledKnowledgeItem[]> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return [];

  const client = new GoogleGenAI({ apiKey });
  const contents: Content[] = [{ role: "user", parts: [{ text: promptText }] }];

  for (const model of CANDIDATE_MODELS) {
    try {
      const response = await client.models.generateContent({
        model,
        contents,
        config: {
          systemInstruction: REFLECTION_SYSTEM_PROMPT,
          responseMimeType: "application/json",
          temperature: 0.1,
        },
      });
      const raw = response.text?.trim() || "{}";
      const fenceStripped = raw
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```$/i, "")
        .trim();
      const parsed = JSON.parse(fenceStripped) as { items?: unknown[] };
      if (!Array.isArray(parsed.items)) return [];

      return parsed.items
        .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
        .map((item) => {
          const categoryRaw = String(item.category ?? "faq").toLowerCase();
          const category: DistilledKnowledgeItem["category"] =
            categoryRaw === "timetable" ||
            categoryRaw === "pricing" ||
            categoryRaw === "general" ||
            categoryRaw === "announcement"
              ? categoryRaw
              : "faq";
          return {
            valuable: Boolean(item.valuable),
            confidence: typeof item.confidence === "number" ? item.confidence : 0,
            category,
            generalizedQuestion: scrubRawPii(String(item.generalizedQuestion ?? "")),
            generalizedAnswer: scrubRawPii(String(item.generalizedAnswer ?? "")),
          };
        })
        .filter(
          (item) =>
            item.valuable &&
            item.confidence >= 0.7 &&
            item.generalizedQuestion.length >= 8 &&
            item.generalizedAnswer.length >= 10,
        );
    } catch (err) {
      logger.warn(
        { model, err: err instanceof Error ? err.message : String(err) },
        "[Cognitive Reflection] Model attempt failed",
      );
    }
  }
  return [];
}

/**
 * Distills a single staff reply in real time: strips PII, ignores casual/personal one-offs,
 * and only queues high-confidence reusable knowledge items.
 */
export async function distillAndCaptureLearning(
  phoneNumber: string,
  staffBody: string,
): Promise<void> {
  const cleanStaff = scrubRawPii(staffBody);
  // Ignore short or purely transactional one-liners without calling the LLM
  if (
    !cleanStaff ||
    cleanStaff.startsWith("[WhatsApp ") ||
    cleanStaff.startsWith("[Image ") ||
    cleanStaff.length < 18
  ) {
    return;
  }

  try {
    const recentMessages = await db
      .select({
        direction: conversationMessagesTable.direction,
        body: conversationMessagesTable.body,
      })
      .from(conversationMessagesTable)
      .where(eq(conversationMessagesTable.phoneNumber, phoneNumber))
      .orderBy(desc(conversationMessagesTable.createdAt))
      .limit(6);

    const hasInbound = recentMessages.some((m) => m.direction === "inbound");
    if (!hasInbound) return;

    const transcript = recentMessages
      .reverse()
      .map((m) => `${m.direction === "inbound" ? "Student" : "Staff/Bot"}: ${scrubRawPii(m.body)}`)
      .join("\n");

    const kbSnippet = readKnowledgeBase().slice(0, 3500);
    const prompt = `EXISTING KNOWLEDGE BASE SUMMARY:\n${kbSnippet}\n\n---\nRECENT STAFF INTERVENTION TRANSCRIPT (PII SCRUBBED):\n${transcript}\n\nLATEST STAFF REPLY TO EVALUATE:\n${cleanStaff}\n\nExtract at most 1 globally reusable FAQ/policy insight if and only if this staff reply contains general class knowledge not specific to one individual student.`;

    const distilled = await runGeminiReflection(prompt);
    for (const item of distilled.slice(0, 1)) {
      await db.insert(suggestedKnowledgeItemsTable).values({
        sourceConversationId: "AI Cognitive Reflection (PII Scrubbed)",
        studentQuestion: item.generalizedQuestion,
        humanStaffResponse: item.generalizedAnswer,
        suggestedCategory: item.category,
        status: "pending",
      });
      logger.info(
        { category: item.category, confidence: item.confidence },
        "[Cognitive Reflection] Distilled anonymized knowledge item for admin review",
      );
    }
  } catch (err) {
    logger.warn({ err }, "[Cognitive Reflection] Failed to distill staff interaction");
  }
}

/**
 * Batch reflection job (nightly cron + on-demand admin button):
 * Scans recent human-handled conversations, strips all PII, and distills recurring questions or new policies.
 */
export async function runBatchCognitiveReflection(hoursBack = 48): Promise<{
  analyzedConversations: number;
  suggestionsCreated: number;
}> {
  const since = new Date(Date.now() - hoursBack * 3600_000);
  const recentMessages = await db
    .select({
      phoneNumber: conversationMessagesTable.phoneNumber,
      direction: conversationMessagesTable.direction,
      body: conversationMessagesTable.body,
      externalId: conversationMessagesTable.externalId,
      createdAt: conversationMessagesTable.createdAt,
    })
    .from(conversationMessagesTable)
    .where(gte(conversationMessagesTable.createdAt, since))
    .orderBy(desc(conversationMessagesTable.createdAt))
    .limit(300);

  // Group by conversation and keep only conversations where human staff sent at least one message
  const byPhone = new Map<string, typeof recentMessages>();
  for (const msg of recentMessages) {
    const list = byPhone.get(msg.phoneNumber) ?? [];
    list.push(msg);
    byPhone.set(msg.phoneNumber, list);
  }

  const staffTranscripts: string[] = [];
  for (const [, msgs] of byPhone.entries()) {
    const hasHumanStaffReply = msgs.some(
      (m) =>
        m.direction === "outbound" &&
        (!m.externalId || !m.externalId.startsWith("almedia_") || m.externalId.startsWith("almedia_dash_")),
    );
    if (!hasHumanStaffReply) continue;

    const ordered = [...msgs].reverse();
    const lines = ordered
      .map((m) => {
        const speaker =
          m.direction === "inbound"
            ? "Student"
            : !m.externalId || m.externalId.startsWith("almedia_dash_")
              ? "Human Staff"
              : "Bot";
        return `${speaker}: ${scrubRawPii(m.body)}`;
      })
      .join("\n");
    if (lines.trim()) {
      staffTranscripts.push(lines);
    }
  }

  if (staffTranscripts.length === 0) {
    return { analyzedConversations: 0, suggestionsCreated: 0 };
  }

  const [existingSuggestions, existingDynamic] = await Promise.all([
    db
      .select({ q: suggestedKnowledgeItemsTable.studentQuestion })
      .from(suggestedKnowledgeItemsTable)
      .orderBy(desc(suggestedKnowledgeItemsTable.createdAt))
      .limit(50),
    db
      .select({ title: dynamicContentTable.title })
      .from(dynamicContentTable)
      .limit(50),
  ]);

  const knownQuestions = new Set([
    ...existingSuggestions.map((s) => s.q.toLowerCase().trim()),
    ...existingDynamic.map((d) => d.title.toLowerCase().trim()),
  ]);

  const kbSnippet = readKnowledgeBase().slice(0, 3500);
  const combinedTranscript = staffTranscripts
    .slice(0, 15)
    .map((t, idx) => `--- Conversation #${idx + 1} ---\n${t}`)
    .join("\n\n");

  const prompt = `EXISTING KNOWLEDGE BASE:\n${kbSnippet}\n\n---\nALREADY QUEUED QUESTIONS:\n${Array.from(knownQuestions).slice(0, 25).join("\n")}\n\n---\nRECENT HUMAN STAFF CONVERSATIONS (ANONYMIZED):\n${combinedTranscript}\n\nAnalyze these human-handled conversations and extract up to 5 high-value, globally reusable FAQ or policy insights that are not already in the Existing Knowledge Base or Already Queued Questions. Remember: ZERO PII.`;

  const distilled = await runGeminiReflection(prompt);
  let created = 0;

  for (const item of distilled.slice(0, 5)) {
    const key = item.generalizedQuestion.toLowerCase().trim();
    if (knownQuestions.has(key)) continue;
    knownQuestions.add(key);

    await db.insert(suggestedKnowledgeItemsTable).values({
      sourceConversationId: "AI Cognitive Reflection (PII Scrubbed)",
      studentQuestion: item.generalizedQuestion,
      humanStaffResponse: item.generalizedAnswer,
      suggestedCategory: item.category,
      status: "pending",
    });
    created += 1;
  }

  logger.info(
    { analyzedConversations: staffTranscripts.length, suggestionsCreated: created },
    "[Cognitive Reflection] Completed batch reflection pass",
  );

  return {
    analyzedConversations: staffTranscripts.length,
    suggestionsCreated: created,
  };
}
