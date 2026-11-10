import crypto from "node:crypto";
import { GoogleGenAI, type Content } from "@google/genai";
import { and, desc, eq, gte, lt } from "drizzle-orm";
import {
  conversationMessagesTable,
  conversationsTable,
  db,
  dynamicContentTable,
  suggestedKnowledgeItemsTable,
} from "@workspace/db";
import { readKnowledgeBase } from "./ai-agent";
import { emitDashboardEvent, kvGet, kvSet } from "./kv";
import { logger } from "./logger";

export const AUTO_PROMOTE_CONFIDENCE_THRESHOLD = 0.88;
const MIN_STAGE_CONFIDENCE_THRESHOLD = 0.6;
const INACTIVITY_REFLECTION_WINDOW_MS = 30 * 60_000;

const CANDIDATE_MODELS = [
  process.env.GEMINI_MODEL,
  "gemini-3.5-flash-lite",
  "gemini-flash-lite-latest",
  "gemini-flash-latest",
  "gemini-3.5-flash",
].filter((m): m is string => Boolean(m));

/** Scrubs Sri Lankan phone numbers, NICs, emails, and image tags from raw text before and after LLM reflection. */
export function scrubRawPii(text: string): string {
  return text
    .replace(/\[IMAGE:[^\]]+\]/g, "[Image Attachment]")
    .replace(/(?<!\d)(?:\+?94[\s-]?|0[\s-]?)?7\d[\s-]?\d{3}[\s-]?\d{4}(?!\d)/g, "[PHONE_REDACTED]")
    .replace(/\b\d{9}[VvXx]\b|\b\d{12}\b/g, "[NIC_REDACTED]")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[EMAIL_REDACTED]")
    .trim();
}

export function isPiiFree(text: string): boolean {
  if (/\[PHONE_REDACTED\]|\[NIC_REDACTED\]|\[EMAIL_REDACTED\]/.test(text)) return false;
  if (/(?<!\d)(?:\+?94[\s-]?|0[\s-]?)?(?:70|71|72|74|75|76|77|78)[\s-]?\d{3}[\s-]?\d{4}(?!\d)/.test(text)) {
    // Allow official class office numbers (071 016 1699, 078 909 4047, 071 254 0000, 071 814 0322)
    const strippedOfficial = text.replace(
      /071[\s-]?016[\s-]?1699|078[\s-]?909[\s-]?4047|071[\s-]?254[\s-]?0000|071[\s-]?814[\s-]?0322/g,
      "",
    );
    if (/(?<!\d)(?:\+?94[\s-]?|0[\s-]?)?7\d[\s-]?\d{3}[\s-]?\d{4}(?!\d)/.test(strippedOfficial)) {
      return false;
    }
  }
  return true;
}

interface DistilledKnowledgeItem {
  valuable: boolean;
  confidence: number;
  category: "faq" | "timetable" | "pricing" | "general" | "announcement";
  synthesizedTitle: string;
  generalizedQuestion: string;
  generalizedAnswer: string;
}

const REFLECTION_SYSTEM_PROMPT = `You are the Autonomous Memory & Self-Distillation Engine (Hermes / MemGPT cognitive architecture) for Suranga Gamage's A/L Mass Media Class Office (mediasuranga.lk).
Your mission is to analyze resolved human-staff conversations and synthesize general class rules, policy updates, fee changes, and timetable nuances into permanent institutional memory.

STRICT SELF-DISTILLATION & SAFETY RULES:
1. NEVER COPY-PASTE RAW CHATS: Synthesize clean, generalized rules or Q&As in natural Sinhala.
2. ZERO PII: Strip all student names, personal phone numbers, NICs, home addresses, bank slip numbers, and parcel tracking numbers. (Official office hotlines 071 016 1699 and 078 909 4047 are allowed).
3. DISCARD ONE-OFF PERSONAL TRANSACTIONS (set "valuable": false, "confidence": 0.0):
   - Individual password reset confirmations ("Your password was reset to 12345678")
   - Individual payment slip verifications
   - Individual tute parcel lookups
   - Casual greetings, acknowledgements, or "wait 5 minutes" replies
4. CONFIDENCE & SAFETY SCORING (0.0 to 1.0):
   - 0.88 – 1.00 (High Confidence -> Auto-Promoted to Active Agent Memory): Clear, unambiguous class schedule facts, official fee rules, general registration/website policies, or recurring academic explanations stated authoritatively by staff.
   - 0.60 – 0.87 (Moderate Confidence -> Staged for Admin Review): Useful FAQ or situational rule that may need human verification before becoming a global policy.
   - < 0.60: Discard.

Return STRICT JSON matching this schema:
{
  "items": [
    {
      "valuable": true,
      "confidence": 0.92,
      "category": "faq",
      "synthesizedTitle": "Short 4-8 word title in Sinhala",
      "generalizedQuestion": "Generalized student question in Sinhala (zero PII)",
      "generalizedAnswer": "Synthesized authoritative policy/answer in Sinhala (zero PII)"
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
          const q = scrubRawPii(String(item.generalizedQuestion ?? ""));
          const a = scrubRawPii(String(item.generalizedAnswer ?? ""));
          const title = scrubRawPii(String(item.synthesizedTitle ?? q.slice(0, 80)));
          const rawConf = typeof item.confidence === "number" ? item.confidence : 0;
          const confidence = Math.max(0, Math.min(1, Number(rawConf.toFixed(2))));
          return {
            valuable: Boolean(item.valuable),
            confidence,
            category,
            synthesizedTitle: title || q.slice(0, 80),
            generalizedQuestion: q,
            generalizedAnswer: a,
          };
        })
        .filter(
          (item) =>
            item.valuable &&
            item.confidence >= MIN_STAGE_CONFIDENCE_THRESHOLD &&
            item.generalizedQuestion.length >= 8 &&
            item.generalizedAnswer.length >= 10,
        );
    } catch (err) {
      logger.warn(
        { model, err: err instanceof Error ? err.message : String(err) },
        "[Autonomous Memory] Gemini reflection attempt failed",
      );
    }
  }
  return [];
}

async function ingestDistilledInsight(item: DistilledKnowledgeItem): Promise<"auto_promoted" | "staged" | "skipped"> {
  const piiSafe =
    isPiiFree(item.generalizedQuestion) &&
    isPiiFree(item.generalizedAnswer) &&
    isPiiFree(item.synthesizedTitle);

  const effectiveConfidence = piiSafe ? item.confidence : Math.min(item.confidence, 0.75);
  const hash = crypto
    .createHash("sha1")
    .update(item.generalizedQuestion.toLowerCase().trim())
    .digest("hex")
    .slice(0, 14);
  const memoryKey = `auto_mem_${hash}`;

  // High-confidence, PII-free insights (>= 0.88) are auto-promoted directly into active dynamic_content!
  if (effectiveConfidence >= AUTO_PROMOTE_CONFIDENCE_THRESHOLD && piiSafe) {
    const content = `Q: ${item.generalizedQuestion}\nA: ${item.generalizedAnswer}`;
    await db
      .insert(dynamicContentTable)
      .values({
        key: memoryKey,
        category: item.category,
        title: item.synthesizedTitle.slice(0, 180),
        content,
        source: "autonomous_reflection",
        confidence: effectiveConfidence,
      })
      .onConflictDoUpdate({
        target: dynamicContentTable.key,
        set: {
          category: item.category,
          title: item.synthesizedTitle.slice(0, 180),
          content,
          source: "autonomous_reflection",
          confidence: effectiveConfidence,
          updatedAt: new Date(),
        },
      });

    await db.insert(suggestedKnowledgeItemsTable).values({
      sourceConversationId: null,
      studentQuestion: item.generalizedQuestion,
      humanStaffResponse: item.generalizedAnswer,
      suggestedCategory: item.category,
      confidence: effectiveConfidence,
      source: "autonomous_reflection",
      status: "approved",
    });

    emitDashboardEvent("memory.auto_promoted", {
      key: memoryKey,
      confidence: effectiveConfidence,
      category: item.category,
    });

    logger.info(
      { key: memoryKey, category: item.category, confidence: effectiveConfidence },
      "[Autonomous Memory] Auto-promoted high-confidence insight into active knowledge context",
    );
    return "auto_promoted";
  }

  // Lower-confidence insights (< 0.88) are staged in suggested_knowledge_items for human audit
  await db.insert(suggestedKnowledgeItemsTable).values({
    sourceConversationId: null,
    studentQuestion: item.generalizedQuestion,
    humanStaffResponse: item.generalizedAnswer,
    suggestedCategory: item.category,
    confidence: effectiveConfidence,
    source: "autonomous_reflection",
    status: "pending",
  });

  emitDashboardEvent("memory.staged", {
    confidence: effectiveConfidence,
    category: item.category,
  });

  logger.info(
    { category: item.category, confidence: effectiveConfidence },
    "[Autonomous Memory] Staged ambiguous insight (< 0.88) for admin review",
  );
  return "staged";
}

/**
 * Distills a single staff reply in the background: strips PII, ignores casual/personal one-offs,
 * auto-promotes high-confidence insights (>= 0.88), and stages lower-confidence ones (< 0.88).
 */
export async function distillAndCaptureLearning(
  phoneNumber: string,
  staffBody: string,
): Promise<void> {
  const cleanStaff = scrubRawPii(staffBody);
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
    const prompt = `EXISTING KNOWLEDGE BASE SUMMARY:\n${kbSnippet}\n\n---\nRECENT STAFF INTERVENTION TRANSCRIPT (PII SCRUBBED):\n${transcript}\n\nLATEST STAFF REPLY TO EVALUATE:\n${cleanStaff}\n\nSynthesize at most 1 globally reusable rule, policy, or FAQ insight if and only if this staff reply contains general class knowledge not specific to one individual student.`;

    const distilled = await runGeminiReflection(prompt);
    for (const item of distilled.slice(0, 1)) {
      await ingestDistilledInsight(item);
    }
  } catch (err) {
    logger.warn({ err }, "[Autonomous Memory] Failed to distill staff interaction");
  }
}

/**
 * Background Autonomous Worker:
 * Scans staff-intervened conversations that have reached >= 30 minutes of inactivity
 * (or resolved staff conversations in the last 48h), distills reusable insights,
 * auto-promotes confidence >= 0.88 directly into `dynamic_content`, and stages < 0.88.
 */
export async function runAutonomousMemoryCycle(hoursBack = 48): Promise<{
  analyzedConversations: number;
  autoPromotedCount: number;
  stagedCount: number;
}> {
  const now = Date.now();
  const since = new Date(now - hoursBack * 3600_000);
  const inactiveBefore = new Date(now - INACTIVITY_REFLECTION_WINDOW_MS);

  // Find conversations with staff activity in the last `hoursBack` hours that have been inactive for >= 30m
  const candidateConvs = await db
    .select({
      phoneNumber: conversationsTable.phoneNumber,
      lastStaffMessageAt: conversationsTable.lastStaffMessageAt,
      lastMessageAt: conversationsTable.lastMessageAt,
    })
    .from(conversationsTable)
    .where(
      and(
        gte(conversationsTable.lastStaffMessageAt, since),
        lt(conversationsTable.lastMessageAt, inactiveBefore),
      ),
    )
    .orderBy(desc(conversationsTable.lastStaffMessageAt))
    .limit(15);

  if (!candidateConvs.length) {
    return { analyzedConversations: 0, autoPromotedCount: 0, stagedCount: 0 };
  }

  const [existingSuggestions, existingDynamic] = await Promise.all([
    db
      .select({ q: suggestedKnowledgeItemsTable.studentQuestion })
      .from(suggestedKnowledgeItemsTable)
      .orderBy(desc(suggestedKnowledgeItemsTable.createdAt))
      .limit(60),
    db
      .select({ title: dynamicContentTable.title })
      .from(dynamicContentTable)
      .limit(60),
  ]);

  const knownKeys = new Set([
    ...existingSuggestions.map((s) => s.q.toLowerCase().trim()),
    ...existingDynamic.map((d) => d.title.toLowerCase().trim()),
  ]);

  const transcriptsToReflect: string[] = [];

  for (const conv of candidateConvs) {
    const stamp = conv.lastStaffMessageAt?.getTime() ?? 0;
    const dedupKey = `reflection:done:${conv.phoneNumber}:${stamp}`;
    if (await kvGet(dedupKey)) continue;

    const msgs = await db
      .select({
        direction: conversationMessagesTable.direction,
        body: conversationMessagesTable.body,
        externalId: conversationMessagesTable.externalId,
      })
      .from(conversationMessagesTable)
      .where(eq(conversationMessagesTable.phoneNumber, conv.phoneNumber))
      .orderBy(desc(conversationMessagesTable.createdAt))
      .limit(12);

    // Mark as reflected for 7 days so we don't re-process the exact same inactive session
    await kvSet(dedupKey, "1", 7 * 86_400);

    const hasStaff = msgs.some(
      (m) =>
        m.direction === "outbound" &&
        (!m.externalId || !m.externalId.startsWith("almedia_") || m.externalId.startsWith("almedia_dash_")),
    );
    if (!hasStaff) continue;

    const lines = [...msgs]
      .reverse()
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
      transcriptsToReflect.push(lines);
    }
  }

  if (!transcriptsToReflect.length) {
    return { analyzedConversations: 0, autoPromotedCount: 0, stagedCount: 0 };
  }

  const kbSnippet = readKnowledgeBase().slice(0, 3500);
  const combinedTranscript = transcriptsToReflect
    .slice(0, 10)
    .map((t, idx) => `--- Resolved Staff Conversation #${idx + 1} ---\n${t}`)
    .join("\n\n");

  const prompt = `EXISTING KNOWLEDGE BASE:\n${kbSnippet}\n\n---\nALREADY KNOWN TOPICS:\n${Array.from(knownKeys).slice(0, 30).join("\n")}\n\n---\nRESOLVED STAFF CONVERSATIONS (30+ MIN INACTIVE, PII SCRUBBED):\n${combinedTranscript}\n\nSynthesize up to 4 globally reusable class rules, schedule nuances, or FAQs that are not already in the Existing Knowledge Base or Already Known Topics. Assign an accurate confidence score (0.0 - 1.0).`;

  const distilled = await runGeminiReflection(prompt);
  let autoPromotedCount = 0;
  let stagedCount = 0;

  for (const item of distilled.slice(0, 4)) {
    const qKey = item.generalizedQuestion.toLowerCase().trim();
    if (knownKeys.has(qKey)) continue;
    knownKeys.add(qKey);

    const outcome = await ingestDistilledInsight(item);
    if (outcome === "auto_promoted") autoPromotedCount += 1;
    else if (outcome === "staged") stagedCount += 1;
  }

  logger.info(
    {
      analyzedConversations: transcriptsToReflect.length,
      autoPromotedCount,
      stagedCount,
    },
    "[Autonomous Memory] Completed background 30m-inactivity reflection cycle",
  );

  return {
    analyzedConversations: transcriptsToReflect.length,
    autoPromotedCount,
    stagedCount,
  };
}
