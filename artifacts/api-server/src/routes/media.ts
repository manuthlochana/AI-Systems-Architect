import fs from "node:fs";
import path from "node:path";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { Router, type IRouter } from "express";
import {
  ApproveRecordingRequestBody,
  ApproveRecordingRequestParams,
  ApproveRecordingRequestResponse,
  CreateAdminSessionBody,
  CreateAdminSessionResponse,
  GetAdminStatusResponse,
  GetConversationsQueryParams,
  GetConversationsResponse,
  GetDashboardSummaryResponse,
  GetDeliveriesQueryParams,
  GetDeliveriesResponse,
  DeleteDynamicContentParams,
  GetDynamicContentResponse,
  GetRecordingRequestsQueryParams,
  GetRecordingRequestsResponse,
  ImportTuteDeliveriesBody,
  ImportTuteDeliveriesResponse,
  InspectTuteDeliveryFileBody,
  InspectTuteDeliveryFileResponse,
  SetConversationModeBody,
  SetConversationModeParams,
  SetConversationModeResponse,
  UpsertDynamicContentParams,
  UpsertDynamicContentBody as DynamicContentBody,
  UpsertDynamicContentResponse,
  GetSuggestedKnowledgeItemsQueryParams,
  GetSuggestedKnowledgeItemsResponse,
  UpdateSuggestedKnowledgeItemParams,
  UpdateSuggestedKnowledgeItemBody,
  UpdateSuggestedKnowledgeItemResponse,
  DeleteSuggestedKnowledgeItemParams,
  ApproveSuggestedKnowledgeItemParams,
  ApproveSuggestedKnowledgeItemResponse,
  RejectSuggestedKnowledgeItemParams,
  RejectSuggestedKnowledgeItemResponse,
} from "@workspace/api-zod";
import {
  conversationMessagesTable,
  conversationsTable,
  db,
  dynamicContentTable,
  recordingRequestsTable,
  suggestedKnowledgeItemsTable,
  tuteDeliveriesTable,
} from "@workspace/db";
import {
  clearAdminSessionCookie,
  isAdminAuthenticated,
  isAdminKeyConfigured,
  isAdminSessionConfigured,
  matchesAdminKey,
  requireAdmin,
  setAdminSessionCookie,
} from "../lib/admin-auth";
import {
  deliveryColumnMapFromHeaders,
  parseSpreadsheet,
  toPhoneKey,
} from "../lib/spreadsheet";
import { isYCloudConfigured, sendYCloudImage, sendYCloudText, uploadYCloudMedia } from "../lib/ycloud";
import { readKnowledgeBase, writeKnowledgeBase } from "../lib/ai-agent";
import { botSettingsTable } from "@workspace/db";
import { DEFAULT_PERSONA, getBotSettings } from "../lib/bot-settings";
import { lockForAdmin, releaseToBot } from "../lib/conversation-state";
import { dashboardEvents, emitDashboardEvent } from "../lib/kv";
import { runBatchCognitiveReflection } from "../lib/reflection";
import { captureShadowLearning } from "../lib/webhook-worker";
import { formatMediaMessageBody, parseMediaMessageBody } from "../lib/whatsapp-event";

const UPLOADS_DIR = path.resolve(process.cwd(), "uploads");

const router: IRouter = Router();
const loginAttempts = new Map<string, { count: number; resetAt: number }>();

type ChatStatus = "bot" | "needs_attention" | "admin_locked";

function chatStatusOf(
  row: Pick<typeof conversationsTable.$inferSelect, "mode" | "needsAttention" | "lastAdminActivityAt" | "lastStaffMessageAt">,
  timeoutHours: number,
): ChatStatus {
  if (row.mode !== "human") return "bot";
  if (row.needsAttention) return "needs_attention";
  const last = row.lastAdminActivityAt ?? row.lastStaffMessageAt;
  if (last && Date.now() - new Date(last).getTime() >= timeoutHours * 3600_000) return "bot";
  return "admin_locked";
}

function serializeConversation(
  row: Pick<
    typeof conversationsTable.$inferSelect,
    | "phoneNumber" | "studentName" | "batch" | "studentType" | "mode" | "lastIntent"
    | "lastMessageAt" | "createdAt" | "needsAttention" | "lastAdminActivityAt" | "lastStaffMessageAt"
  > & { lastMessage: string | null },
  timeoutHours = 4,
) {
  return {
    phoneNumber: row.phoneNumber,
    studentName: row.studentName,
    batch: row.batch,
    studentType: row.studentType,
    mode: row.mode,
    lastIntent: row.lastIntent,
    lastMessageAt: row.lastMessageAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    lastMessage: row.lastMessage,
    chatStatus: chatStatusOf(row, timeoutHours),
  };
}

/** Resolves a dashboard-supplied id (phone in any format) to the stored conversation phone number. */
async function resolveConversationPhone(raw: string): Promise<string | null> {
  const phone = raw.trim();
  const [found] = await db
    .select({ phoneNumber: conversationsTable.phoneNumber })
    .from(conversationsTable)
    .where(eq(conversationsTable.phoneNumber, phone))
    .limit(1);
  if (found) return found.phoneNumber;
  const digits = phone.replace(/\D/g, "").slice(-9);
  if (digits.length !== 9) return null;
  const [byDigits] = await db
    .select({ phoneNumber: conversationsTable.phoneNumber })
    .from(conversationsTable)
    .where(sql`right(regexp_replace(${conversationsTable.phoneNumber}, '\\D', '', 'g'), 9) = ${digits}`)
    .limit(1);
  return byDigits?.phoneNumber ?? null;
}

async function conversationWithLastMessage(phoneNumber: string) {
  const [conversation] = await db
    .select()
    .from(conversationsTable)
    .where(eq(conversationsTable.phoneNumber, phoneNumber))
    .limit(1);
  if (!conversation) return null;
  const [lastMessage] = await db
    .select({ body: conversationMessagesTable.body })
    .from(conversationMessagesTable)
    .where(eq(conversationMessagesTable.phoneNumber, phoneNumber))
    .orderBy(desc(conversationMessagesTable.createdAt))
    .limit(1);
  const settings = await getBotSettings();
  return {
    ...serializeConversation(
      { ...conversation, lastMessage: lastMessage?.body ?? null },
      settings.handoverTimeoutHours,
    ),
    gender: conversation.gender,
    examYear: conversation.examYear,
    hometownDistrict: conversation.hometownDistrict,
    otherSubjects: conversation.otherSubjects,
    classType: conversation.classType,
    physicalLocation: conversation.physicalLocation,
    onboardingStatus: conversation.onboardingStatus,
  };
}

function serializeDelivery(row: typeof tuteDeliveriesTable.$inferSelect) {
  return { ...row, createdAt: row.createdAt.toISOString() };
}

function serializeContent(row: typeof dynamicContentTable.$inferSelect) {
  return { ...row, updatedAt: row.updatedAt.toISOString() };
}

function serializeRecordingRequest(row: typeof recordingRequestsTable.$inferSelect) {
  return { ...row, createdAt: row.createdAt.toISOString() };
}

function serializeSuggestion(row: typeof suggestedKnowledgeItemsTable.$inferSelect) {
  return {
    id: row.id,
    sourceConversationId: row.sourceConversationId,
    studentQuestion: row.studentQuestion,
    humanStaffResponse: row.humanStaffResponse,
    suggestedCategory: row.suggestedCategory,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
  };
}

function validateLoginRateLimit(ip: string): boolean {
  const now = Date.now();
  const attempts = loginAttempts.get(ip);
  if (!attempts || attempts.resetAt <= now) {
    loginAttempts.set(ip, { count: 1, resetAt: now + 15 * 60 * 1000 });
    return true;
  }
  if (attempts.count >= 8) return false;
  attempts.count += 1;
  return true;
}

router.get("/admin/status", (req, res): void => {
  res.json(
    GetAdminStatusResponse.parse({
      adminConfigured: isAdminKeyConfigured(),
      sessionConfigured: isAdminSessionConfigured(),
      databaseConfigured: Boolean(process.env.DATABASE_URL),
      geminiConfigured: Boolean(process.env.GEMINI_API_KEY),
      ycloudConfigured: isYCloudConfigured(),
      authenticated: isAdminAuthenticated(req),
    }),
  );
});

router.post("/admin/session", (req, res): void => {
  const parsed = CreateAdminSessionBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  if (!isAdminKeyConfigured() || !isAdminSessionConfigured()) {
    res.status(503).json({
      error: "Add ADMIN_API_KEY and SESSION_SECRET in Replit Secrets to enable admin sign-in.",
    });
    return;
  }
  if (!validateLoginRateLimit(req.ip ?? "unknown")) {
    res.status(429).json({ error: "Too many sign-in attempts. Try again in 15 minutes." });
    return;
  }
  if (!matchesAdminKey(parsed.data.key)) {
    req.log.warn("Rejected admin sign-in attempt");
    res.status(401).json({ error: "The admin key is not valid." });
    return;
  }
  setAdminSessionCookie(res);
  res.json(CreateAdminSessionResponse.parse({ authenticated: true }));
});

router.delete("/admin/session", (_req, res): void => {
  clearAdminSessionCookie(res);
  res.status(204).end();
});

router.get("/dashboard/summary", requireAdmin, async (_req, res): Promise<void> => {
  const currentMonth = new Date().toISOString().slice(0, 7);
  const [humanQueue, pendingRecordings, monthlyDeliveries, recentConversations, recentRecordingRequests, recentContent] =
    await Promise.all([
      db.select({ count: sql<number>`count(*)::int` }).from(conversationsTable).where(eq(conversationsTable.mode, "human")),
      db.select({ count: sql<number>`count(*)::int` }).from(recordingRequestsTable).where(eq(recordingRequestsTable.status, "pending")),
      db.select({ count: sql<number>`count(*)::int` }).from(tuteDeliveriesTable).where(eq(tuteDeliveriesTable.month, currentMonth)),
      db.select().from(conversationsTable).orderBy(desc(conversationsTable.lastMessageAt)).limit(5),
      db.select().from(recordingRequestsTable).orderBy(desc(recordingRequestsTable.createdAt)).limit(3),
      db.select().from(dynamicContentTable).orderBy(desc(dynamicContentTable.updatedAt)).limit(2),
    ]);

  const recentActivity = [
    ...recentConversations.map((item) => ({
      id: `conversation:${item.phoneNumber}`,
      description: `WhatsApp conversation · ${item.studentName ?? item.phoneNumber}`,
      at: item.lastMessageAt.toISOString(),
      kind: "conversation" as const,
    })),
    ...recentRecordingRequests.map((item) => ({
      id: `recording:${item.id}`,
      description: `Recording request · ${item.studentName ?? item.phoneNumber} · ${item.status}`,
      at: item.createdAt.toISOString(),
      kind: "recording" as const,
    })),
    ...recentContent.map((item) => ({
      id: `content:${item.key}`,
      description: `Content updated · ${item.title}`,
      at: item.updatedAt.toISOString(),
      kind: "content" as const,
    })),
  ]
    .sort((left, right) => right.at.localeCompare(left.at))
    .slice(0, 6);

  res.json(
    GetDashboardSummaryResponse.parse({
      humanQueueCount: humanQueue[0]?.count ?? 0,
      pendingRecordingCount: pendingRecordings[0]?.count ?? 0,
      deliveriesThisMonth: monthlyDeliveries[0]?.count ?? 0,
      recentConversationCount: recentConversations.length,
      recentActivity,
    }),
  );
});

router.get("/conversations", requireAdmin, async (req, res): Promise<void> => {
  const query = GetConversationsQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }

  const rows = await db
    .select({
      phoneNumber: conversationsTable.phoneNumber,
      studentName: conversationsTable.studentName,
      batch: conversationsTable.batch,
      studentType: conversationsTable.studentType,
      mode: conversationsTable.mode,
      lastIntent: conversationsTable.lastIntent,
      lastMessageAt: conversationsTable.lastMessageAt,
      createdAt: conversationsTable.createdAt,
      needsAttention: conversationsTable.needsAttention,
      lastAdminActivityAt: conversationsTable.lastAdminActivityAt,
      lastStaffMessageAt: conversationsTable.lastStaffMessageAt,
      lastMessage: sql<string | null>`(
        select ${conversationMessagesTable.body}
        from ${conversationMessagesTable}
        where ${conversationMessagesTable.phoneNumber} = ${conversationsTable.phoneNumber}
        order by ${conversationMessagesTable.createdAt} desc
        limit 1
      )`,
    })
    .from(conversationsTable)
    .where(
      query.data.mode === "all"
        ? undefined
        : eq(conversationsTable.mode, query.data.mode),
    )
    .orderBy(desc(conversationsTable.lastMessageAt))
    .limit(query.data.limit);

  const settings = await getBotSettings();
  res.json(
    GetConversationsResponse.parse(
      rows.map((row) => serializeConversation(row, settings.handoverTimeoutHours)),
    ),
  );
});

router.patch(
  "/conversations/:phoneNumber/mode",
  requireAdmin,
  async (req, res): Promise<void> => {
    const params = SetConversationModeParams.safeParse(req.params);
    const body = SetConversationModeBody.safeParse(req.body);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    if (!body.success) {
      res.status(400).json({ error: body.error.message });
      return;
    }

    const [conversation] = await db
      .update(conversationsTable)
      .set({
        mode: body.data.mode,
        lastMessageAt: new Date(),
        ...(body.data.mode === "human" ? { lastStaffMessageAt: new Date() } : {}),
      })
      .where(eq(conversationsTable.phoneNumber, params.data.phoneNumber))
      .returning();
    if (!conversation) {
      res.status(404).json({ error: "Conversation not found" });
      return;
    }
    // Keep the Redis admin lock + attention flag consistent with the mode switch.
    if (body.data.mode === "bot") await releaseToBot(conversation.phoneNumber);
    else await lockForAdmin(conversation.phoneNumber);
    const refreshed = await conversationWithLastMessage(conversation.phoneNumber);
    res.json(SetConversationModeResponse.parse(refreshed));
  },
);

router.post(
  ["/admin/conversations/:phoneNumber/mode", "/admin/conversations/:phone/mode", "/conversations/:phoneNumber/mode"],
  requireAdmin,
  async (req, res): Promise<void> => {
    const rawParam = req.params.phoneNumber ?? req.params.phone ?? "";
    const rawPhone = (Array.isArray(rawParam) ? rawParam[0] : String(rawParam)).trim();
    const mode = req.body?.mode;
    if (mode !== "human" && mode !== "bot") {
      res.status(400).json({ error: "Mode must be 'human' or 'bot'" });
      return;
    }

    let phoneToUpdate = rawPhone;
    const [found] = await db
      .select({ phoneNumber: conversationsTable.phoneNumber })
      .from(conversationsTable)
      .where(eq(conversationsTable.phoneNumber, rawPhone))
      .limit(1);

    if (!found) {
      const digits = rawPhone.replace(/\D/g, "").slice(-9);
      if (digits.length === 9) {
        const [byDigits] = await db
          .select({ phoneNumber: conversationsTable.phoneNumber })
          .from(conversationsTable)
          .where(sql`right(regexp_replace(${conversationsTable.phoneNumber}, '\\D', '', 'g'), 9) = ${digits}`)
          .limit(1);
        if (byDigits) {
          phoneToUpdate = byDigits.phoneNumber;
        }
      }
    }

    const [conversation] = await db
      .update(conversationsTable)
      .set({
        mode,
        lastMessageAt: new Date(),
        ...(mode === "human" ? { lastStaffMessageAt: new Date() } : {}),
      })
      .where(eq(conversationsTable.phoneNumber, phoneToUpdate))
      .returning();

    if (!conversation) {
      res.status(404).json({ error: "Conversation not found" });
      return;
    }

    // Keep the Redis admin lock + attention flag consistent with the mode switch.
    if (mode === "bot") await releaseToBot(conversation.phoneNumber);
    else await lockForAdmin(conversation.phoneNumber);
    const refreshed = await conversationWithLastMessage(conversation.phoneNumber);
    res.json(SetConversationModeResponse.parse(refreshed));
  },
);

router.get("/admin/knowledge", requireAdmin, async (_req, res): Promise<void> => {
  const content = readKnowledgeBase();
  res.json({ content });
});

router.put("/admin/knowledge", requireAdmin, async (req, res): Promise<void> => {
  const content = req.body?.content;
  if (typeof content !== "string" || content.trim().length < 5) {
    res.status(400).json({ error: "Knowledge base content must be at least 5 characters long." });
    return;
  }
  try {
    writeKnowledgeBase(content);
    res.json({ success: true, message: "Knowledge base updated successfully." });
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : "Failed to write knowledge base.",
    });
  }
});

router.get("/admin/logs", requireAdmin, async (_req, res): Promise<void> => {
  const pm2OutLog = "/home/ubuntu/.pm2/logs/media-bot-api-out.log";
  const pm2ErrLog = "/home/ubuntu/.pm2/logs/media-bot-api-error.log";
  const lines: string[] = [];

  try {
    if (fs.existsSync(pm2OutLog)) {
      const content = fs.readFileSync(pm2OutLog, "utf8");
      const splitLines = content.split("\n").filter((l) => l.trim().length > 0);
      lines.push(...splitLines.slice(-30));
    }
  } catch {}

  if (lines.length === 0) {
    try {
      if (fs.existsSync(pm2ErrLog)) {
        const content = fs.readFileSync(pm2ErrLog, "utf8");
        const splitLines = content.split("\n").filter((l) => l.trim().length > 0);
        lines.push(...splitLines.slice(-30));
      }
    } catch {}
  }

  if (lines.length === 0) {
    lines.push(
      `[${new Date().toISOString()}] Server online on port ${process.env.PORT || 3050}`,
      `[${new Date().toISOString()}] Supabase Database pool connection active`,
      `[${new Date().toISOString()}] Gemini Flash model active with knowledge-base.md`,
      `[${new Date().toISOString()}] WhatsApp YCloud webhook listener online`,
    );
  }

  res.json({ logs: lines.slice(-30) });
});

router.get("/deliveries", requireAdmin, async (req, res): Promise<void> => {
  const rawMonth = typeof req.query?.month === "string" ? req.query.month : "";
  const match = rawMonth.match(/^(\d{4}-\d{2})/);
  const normalizedQuery = {
    ...req.query,
    month: match ? match[1] : rawMonth.slice(0, 7),
  };
  const query = GetDeliveriesQueryParams.safeParse(normalizedQuery);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  const rows = await db
    .select()
    .from(tuteDeliveriesTable)
    .where(eq(tuteDeliveriesTable.month, query.data.month))
    .orderBy(desc(tuteDeliveriesTable.createdAt))
    .limit(500);
  res.json(GetDeliveriesResponse.parse(rows.map(serializeDelivery)));
});

router.post("/deliveries/inspect", requireAdmin, async (req, res): Promise<void> => {
  const parsed = InspectTuteDeliveryFileBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  try {
    const { columns, rows } = parseSpreadsheet(parsed.data.fileName, parsed.data.fileData);
    res.json(
      InspectTuteDeliveryFileResponse.parse({
        columns,
        previewRows: rows.slice(0, 5),
        rowCount: rows.length,
      }),
    );
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : "Unable to read this spreadsheet.",
    });
  }
});

router.post("/deliveries/import", requireAdmin, async (req, res): Promise<void> => {
  const rawMonth = typeof req.body?.month === "string" ? req.body.month : "";
  const match = rawMonth.match(/^(\d{4}-\d{2})/);
  const normalizedBody = {
    ...req.body,
    month: match ? match[1] : rawMonth.slice(0, 7),
  };
  const parsed = ImportTuteDeliveriesBody.safeParse(normalizedBody);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  let rows: ReturnType<typeof parseSpreadsheet>["rows"];
  try {
    rows = parseSpreadsheet(parsed.data.fileName, parsed.data.fileData).rows;
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : "Unable to read this spreadsheet.",
    });
    return;
  }

  const columnMap = parsed.data.columnMap;
  const requiredColumns = Object.values(columnMap);
  if (requiredColumns.some((column) => !column) || new Set(requiredColumns).size !== 4) {
    res.status(400).json({ error: "Choose a different spreadsheet column for each field." });
    return;
  }

  const { deliveryWave, itemType } = parsed.data;
  const normalizedRows = new Map<
    string,
    { phoneNumber: string; studentName: string | null; trackingNumber: string; address: string | null }
  >();
  const errors: string[] = [];
  let skipped = 0;

  rows.forEach((row, index) => {
    try {
      for (const column of requiredColumns) {
        if (!(column in row)) throw new Error(`Column "${column}" was not found`);
      }
      // Uniform 9-digit key so +9478…, 078… and spaced/hyphenated numbers all match.
      const phoneNumber = toPhoneKey(row[columnMap.phoneNumber] ?? "");
      const trackingNumber = (row[columnMap.trackingNumber] ?? "").trim();
      if (!trackingNumber) throw new Error("Tracking number is empty");
      const key = `${phoneNumber}:${parsed.data.month}:${deliveryWave}:${itemType}`;
      normalizedRows.set(key, {
        phoneNumber,
        studentName: row[columnMap.studentName]?.trim() || null,
        trackingNumber,
        address: row[columnMap.address]?.trim() || null,
      });
    } catch (error) {
      skipped += 1;
      if (errors.length < 25) {
        errors.push(
          `Row ${index + 2}: ${error instanceof Error ? error.message : "Invalid delivery row"}`,
        );
      }
    }
  });

  const records = [...normalizedRows.values()];
  const phones = records.map((record) => record.phoneNumber);
  // Only rows for this exact month + wave + item are matched/updated; other waves are untouched.
  const scope = and(
    eq(tuteDeliveriesTable.month, parsed.data.month),
    eq(tuteDeliveriesTable.deliveryWave, deliveryWave),
    eq(tuteDeliveriesTable.itemType, itemType),
  );
  const existingRows = phones.length
    ? await db
        .select({ phoneNumber: tuteDeliveriesTable.phoneNumber })
        .from(tuteDeliveriesTable)
        .where(and(scope, inArray(tuteDeliveriesTable.phoneNumber, phones)))
    : [];
  const existingPhones = new Set(existingRows.map((row) => row.phoneNumber));
  const CHUNK = 500;
  for (let offset = 0; offset < records.length; offset += CHUNK) {
    await db
      .insert(tuteDeliveriesTable)
      .values(
        records.slice(offset, offset + CHUNK).map((record) => ({
          ...record,
          month: parsed.data.month,
          deliveryWave,
          itemType,
          status: "Dispatched" as const,
        })),
      )
      .onConflictDoUpdate({
        target: [
          tuteDeliveriesTable.phoneNumber,
          tuteDeliveriesTable.month,
          tuteDeliveriesTable.deliveryWave,
          tuteDeliveriesTable.itemType,
        ],
        set: {
          studentName: sql`excluded.student_name`,
          trackingNumber: sql`excluded.tracking_number`,
          address: sql`excluded.address`,
          status: "Dispatched",
        },
      });
  }

  res.json(
    ImportTuteDeliveriesResponse.parse({
      processed: rows.length,
      inserted: records.filter((record) => !existingPhones.has(record.phoneNumber)).length,
      updated: records.filter((record) => existingPhones.has(record.phoneNumber)).length,
      skipped,
      errors,
    }),
  );
});

router.get("/content", requireAdmin, async (_req, res): Promise<void> => {
  const rows = await db
    .select()
    .from(dynamicContentTable)
    .orderBy(dynamicContentTable.category, dynamicContentTable.key);
  res.json(GetDynamicContentResponse.parse(rows.map(serializeContent)));
});

router.put("/content/:key", requireAdmin, async (req, res): Promise<void> => {
  const params = UpsertDynamicContentParams.safeParse(req.params);
  const body = DynamicContentBody.safeParse(req.body);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  const [saved] = await db
    .insert(dynamicContentTable)
    .values({ key: params.data.key, ...body.data })
    .onConflictDoUpdate({
      target: dynamicContentTable.key,
      set: { ...body.data, updatedAt: new Date() },
    })
    .returning();
  res.json(UpsertDynamicContentResponse.parse(serializeContent(saved)));
});

router.delete("/content/:key", requireAdmin, async (req, res): Promise<void> => {
  const params = DeleteDynamicContentParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const deleted = await db
    .delete(dynamicContentTable)
    .where(eq(dynamicContentTable.key, params.data.key))
    .returning({ key: dynamicContentTable.key });
  if (!deleted.length) {
    res.status(404).json({ error: "Content entry not found" });
    return;
  }
  res.status(204).end();
});

router.get("/admin/suggestions", requireAdmin, async (req, res): Promise<void> => {
  const query = GetSuggestedKnowledgeItemsQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  const filter =
    query.data.status === "all"
      ? undefined
      : eq(suggestedKnowledgeItemsTable.status, query.data.status);

  const rows = await db
    .select()
    .from(suggestedKnowledgeItemsTable)
    .where(filter)
    .orderBy(desc(suggestedKnowledgeItemsTable.createdAt));

  res.json(GetSuggestedKnowledgeItemsResponse.parse(rows.map(serializeSuggestion)));
});

router.patch("/admin/suggestions/:id", requireAdmin, async (req, res): Promise<void> => {
  const params = UpdateSuggestedKnowledgeItemParams.safeParse(req.params);
  const body = UpdateSuggestedKnowledgeItemBody.safeParse(req.body);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  const [updated] = await db
    .update(suggestedKnowledgeItemsTable)
    .set({
      ...(body.data.studentQuestion ? { studentQuestion: body.data.studentQuestion } : {}),
      ...(body.data.humanStaffResponse ? { humanStaffResponse: body.data.humanStaffResponse } : {}),
      ...(body.data.suggestedCategory ? { suggestedCategory: body.data.suggestedCategory } : {}),
    })
    .where(eq(suggestedKnowledgeItemsTable.id, params.data.id))
    .returning();

  if (!updated) {
    res.status(404).json({ error: "Suggested item not found" });
    return;
  }

  res.json(UpdateSuggestedKnowledgeItemResponse.parse(serializeSuggestion(updated)));
});

router.delete("/admin/suggestions/:id", requireAdmin, async (req, res): Promise<void> => {
  const params = DeleteSuggestedKnowledgeItemParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const deleted = await db
    .delete(suggestedKnowledgeItemsTable)
    .where(eq(suggestedKnowledgeItemsTable.id, params.data.id))
    .returning({ id: suggestedKnowledgeItemsTable.id });

  if (!deleted.length) {
    res.status(404).json({ error: "Suggested item not found" });
    return;
  }

  res.status(204).end();
});

router.post("/admin/suggestions/:id/approve", requireAdmin, async (req, res): Promise<void> => {
  const params = ApproveSuggestedKnowledgeItemParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [item] = await db
    .select()
    .from(suggestedKnowledgeItemsTable)
    .where(eq(suggestedKnowledgeItemsTable.id, params.data.id))
    .limit(1);

  if (!item) {
    res.status(404).json({ error: "Suggested item not found" });
    return;
  }

  await db
    .update(suggestedKnowledgeItemsTable)
    .set({ status: "approved" })
    .where(eq(suggestedKnowledgeItemsTable.id, params.data.id));

  const cleanKey = `faq_${item.id.replace(/-/g, "").slice(0, 16)}`;
  const title = item.studentQuestion.slice(0, 100);
  const content = `Q: ${item.studentQuestion}\nA: ${item.humanStaffResponse}`;

  const [saved] = await db
    .insert(dynamicContentTable)
    .values({
      key: cleanKey,
      category: "faq",
      title,
      content,
    })
    .onConflictDoUpdate({
      target: dynamicContentTable.key,
      set: {
        category: "faq",
        title,
        content,
        updatedAt: new Date(),
      },
    })
    .returning();

  res.json(ApproveSuggestedKnowledgeItemResponse.parse(serializeContent(saved)));
});

router.post("/admin/suggestions/:id/reject", requireAdmin, async (req, res): Promise<void> => {
  const params = RejectSuggestedKnowledgeItemParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [updated] = await db
    .update(suggestedKnowledgeItemsTable)
    .set({ status: "rejected" })
    .where(eq(suggestedKnowledgeItemsTable.id, params.data.id))
    .returning();

  if (!updated) {
    res.status(404).json({ error: "Suggested item not found" });
    return;
  }

  res.json(RejectSuggestedKnowledgeItemResponse.parse(serializeSuggestion(updated)));
});

router.post("/admin/suggestions/reflect", requireAdmin, async (req, res): Promise<void> => {
  const hoursBack =
    typeof req.body?.hoursBack === "number" && req.body.hoursBack > 0
      ? Math.min(168, req.body.hoursBack)
      : 48;
  try {
    const result = await runBatchCognitiveReflection(hoursBack);
    res.json({
      ok: true,
      analyzedConversations: result.analyzedConversations,
      suggestionsCreated: result.suggestionsCreated,
    });
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : "Failed to run cognitive reflection.",
    });
  }
});

// ---------------------------------------------------------------------------
// Unified inbox: thread view, dashboard reply, handover, bot settings, live events
// ---------------------------------------------------------------------------

router.get("/admin/media/:filename", requireAdmin, (req, res): void => {
  const rawName = String(req.params.filename ?? "");
  const safeName = path.basename(rawName).replace(/[^a-zA-Z0-9._-]/g, "");
  if (!safeName) {
    res.status(400).json({ error: "Invalid media filename" });
    return;
  }
  const filePath = path.join(UPLOADS_DIR, safeName);
  if (!fs.existsSync(filePath)) {
    res.status(404).json({ error: "Media file not found" });
    return;
  }
  const ext = path.extname(safeName).toLowerCase();
  const mime =
    ext === ".png"
      ? "image/png"
      : ext === ".webp"
        ? "image/webp"
        : ext === ".gif"
          ? "image/gif"
          : "image/jpeg";
  res.setHeader("Content-Type", mime);
  res.setHeader("Cache-Control", "private, max-age=86400");
  fs.createReadStream(filePath).pipe(res);
});

router.get("/conversations/:phoneNumber/messages", requireAdmin, async (req, res): Promise<void> => {
  const phone = await resolveConversationPhone(String(req.params.phoneNumber ?? ""));
  if (!phone) {
    res.status(404).json({ error: "Conversation not found" });
    return;
  }
  const rows = await db
    .select()
    .from(conversationMessagesTable)
    .where(eq(conversationMessagesTable.phoneNumber, phone))
    .orderBy(desc(conversationMessagesTable.createdAt))
    .limit(200);
  const conversation = await conversationWithLastMessage(phone);
  res.json({
    conversation,
    messages: rows.reverse().map((row) => {
      const parsedMedia = parseMediaMessageBody(row.body);
      return {
        id: row.id,
        direction: row.direction,
        body: parsedMedia.mediaUrl ? parsedMedia.caption : row.body,
        mediaUrl: parsedMedia.mediaUrl,
        deliveryStatus: row.deliveryStatus,
        createdAt: row.createdAt.toISOString(),
        sender:
          row.direction === "inbound"
            ? "student"
            : row.externalId?.startsWith("almedia_dash_")
              ? "admin"
              : row.externalId?.startsWith("almedia_")
                ? "meedi"
                : "admin",
      };
    }),
  });
});

router.post("/conversations/:phoneNumber/send-message", requireAdmin, async (req, res): Promise<void> => {
  const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
  const imageData = typeof req.body?.imageData === "string" ? req.body.imageData.trim() : "";
  const imageName = typeof req.body?.imageName === "string" ? req.body.imageName.trim() : "image.jpg";
  const imageMimeType =
    typeof req.body?.imageMimeType === "string" && req.body.imageMimeType.startsWith("image/")
      ? req.body.imageMimeType.trim()
      : "image/jpeg";
  const imageUrl =
    typeof req.body?.imageUrl === "string" && /^https?:\/\//i.test(req.body.imageUrl.trim())
      ? req.body.imageUrl.trim()
      : "";

  if (!text && !imageData && !imageUrl) {
    res.status(400).json({ error: "Message text or an image attachment is required." });
    return;
  }
  if (text.length > 4000) {
    res.status(400).json({ error: "Message text cannot exceed 4000 characters." });
    return;
  }

  const phone = await resolveConversationPhone(String(req.params.phoneNumber ?? ""));
  if (!phone) {
    res.status(404).json({ error: "Conversation not found" });
    return;
  }
  if (!process.env.YCLOUD_API_KEY || !process.env.YCLOUD_FROM_NUMBER) {
    res.status(503).json({ error: "YCloud sending is not configured." });
    return;
  }

  const externalId = `almedia_dash_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  let providerMessageId: string | null = null;
  let storedBody = text;
  let savedMediaUrl: string | null = null;

  try {
    if (imageData) {
      const commaIdx = imageData.indexOf(",");
      const base64Clean = commaIdx >= 0 ? imageData.slice(commaIdx + 1) : imageData;
      const buffer = Buffer.from(base64Clean, "base64");
      if (!buffer.length || buffer.length > 10 * 1024 * 1024) {
        res.status(400).json({ error: "Image file must be under 10 MB." });
        return;
      }

      fs.mkdirSync(UPLOADS_DIR, { recursive: true });
      const ext =
        imageMimeType === "image/png"
          ? ".png"
          : imageMimeType === "image/webp"
            ? ".webp"
            : imageMimeType === "image/gif"
              ? ".gif"
              : ".jpg";
      const localFileName = `media_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`;
      fs.writeFileSync(path.join(UPLOADS_DIR, localFileName), buffer);
      savedMediaUrl = `/api/admin/media/${localFileName}`;

      const ycloudMediaId = await uploadYCloudMedia(buffer, imageMimeType, imageName || localFileName);
      providerMessageId = await sendYCloudImage(
        phone,
        { id: ycloudMediaId, caption: text || undefined },
        externalId,
      );
      storedBody = formatMediaMessageBody(savedMediaUrl, text);
    } else if (imageUrl) {
      providerMessageId = await sendYCloudImage(
        phone,
        { link: imageUrl, caption: text || undefined },
        externalId,
      );
      savedMediaUrl = imageUrl;
      storedBody = formatMediaMessageBody(imageUrl, text);
    } else {
      providerMessageId = await sendYCloudText(phone, text, externalId);
    }
  } catch (error) {
    req.log.error({ err: error instanceof Error ? error.message : String(error) }, "Dashboard reply failed");
    res.status(502).json({ error: "WhatsApp delivery failed. Please try again." });
    return;
  }

  const [saved] = await db
    .insert(conversationMessagesTable)
    .values({
      phoneNumber: phone,
      direction: "outbound",
      body: storedBody,
      externalId,
      providerMessageId: providerMessageId ?? undefined,
      deliveryStatus: "sent",
    })
    .onConflictDoNothing()
    .returning();

  // Dashboard reply = admin interruption: human mode + rolling lock refresh.
  await lockForAdmin(phone);
  if (text) {
    await captureShadowLearning(phone, text);
  }
  emitDashboardEvent("message.outbound", { phoneNumber: phone });

  res.json({
    ok: true,
    message: saved
      ? {
          id: saved.id,
          direction: saved.direction,
          body: text,
          mediaUrl: savedMediaUrl,
          deliveryStatus: saved.deliveryStatus,
          createdAt: saved.createdAt.toISOString(),
          sender: "admin",
        }
      : null,
    conversation: await conversationWithLastMessage(phone),
  });
});

router.post("/conversations/:phoneNumber/handover-to-bot", requireAdmin, async (req, res): Promise<void> => {
  const phone = await resolveConversationPhone(String(req.params.phoneNumber ?? ""));
  if (!phone) {
    res.status(404).json({ error: "Conversation not found" });
    return;
  }
  await releaseToBot(phone);
  res.json({ ok: true, conversation: await conversationWithLastMessage(phone) });
});

function serializeBotSettings(row: typeof botSettingsTable.$inferSelect) {
  return {
    systemPrompt: row.systemPrompt,
    enabled: row.enabled,
    temperature: row.temperature,
    handoverTimeoutHours: row.handoverTimeoutHours,
    updatedAt: row.updatedAt.toISOString(),
  };
}

router.get("/admin/bot-settings", requireAdmin, async (_req, res): Promise<void> => {
  const settings = await getBotSettings();
  res.json({
    ...serializeBotSettings(settings),
    // Empty prompt means "use the built-in default"; show it so admins can edit from a baseline.
    defaultPrompt: DEFAULT_PERSONA,
  });
});

router.put("/admin/bot-settings", requireAdmin, async (req, res): Promise<void> => {
  const body = req.body ?? {};
  const patch: Partial<typeof botSettingsTable.$inferInsert> = {};
  if (body.systemPrompt !== undefined) {
    if (typeof body.systemPrompt !== "string" || body.systemPrompt.length > 20000) {
      res.status(400).json({ error: "systemPrompt must be a string (max 20000 characters)." });
      return;
    }
    patch.systemPrompt = body.systemPrompt;
  }
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== "boolean") {
      res.status(400).json({ error: "enabled must be a boolean." });
      return;
    }
    patch.enabled = body.enabled;
  }
  if (body.temperature !== undefined) {
    if (typeof body.temperature !== "number" || body.temperature < 0 || body.temperature > 2) {
      res.status(400).json({ error: "temperature must be a number between 0 and 2." });
      return;
    }
    patch.temperature = body.temperature;
  }
  if (body.handoverTimeoutHours !== undefined) {
    if (!Number.isInteger(body.handoverTimeoutHours) || body.handoverTimeoutHours < 1 || body.handoverTimeoutHours > 168) {
      res.status(400).json({ error: "handoverTimeoutHours must be a whole number between 1 and 168." });
      return;
    }
    patch.handoverTimeoutHours = body.handoverTimeoutHours;
  }

  await getBotSettings(); // ensure the singleton row exists
  const [saved] = await db
    .update(botSettingsTable)
    .set(patch)
    .where(eq(botSettingsTable.id, 1))
    .returning();
  emitDashboardEvent("settings.updated");
  res.json({ ...serializeBotSettings(saved), defaultPrompt: DEFAULT_PERSONA });
});

/** Server-sent events: pushes inbound/outbound/escalation events to open dashboards. */
router.get("/admin/events", requireAdmin, (req, res): void => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(": connected\n\n");
  const onEvent = (event: unknown) => res.write(`data: ${JSON.stringify(event)}\n\n`);
  dashboardEvents.on("event", onEvent);
  const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
  req.on("close", () => {
    clearInterval(ping);
    dashboardEvents.off("event", onEvent);
  });
});

router.get("/recording-requests", requireAdmin, async (req, res): Promise<void> => {
  const query = GetRecordingRequestsQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  const filter =
    query.data.status === "all"
      ? undefined
      : eq(recordingRequestsTable.status, query.data.status);
  const rows = await db
    .select()
    .from(recordingRequestsTable)
    .where(filter)
    .orderBy(desc(recordingRequestsTable.createdAt))
    .limit(query.data.limit);
  res.json(GetRecordingRequestsResponse.parse(rows.map(serializeRecordingRequest)));
});

router.post(
  "/recording-requests/:id/approve",
  requireAdmin,
  async (req, res): Promise<void> => {
    const params = ApproveRecordingRequestParams.safeParse(req.params);
    const body = ApproveRecordingRequestBody.safeParse(req.body);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    if (!body.success) {
      res.status(400).json({ error: body.error.message });
      return;
    }
    let url: URL;
    try {
      url = new URL(body.data.zoomLink);
    } catch {
      res.status(400).json({ error: "Enter a secure Zoom recording link." });
      return;
    }
    const host = url.hostname.toLowerCase();
    if (
      url.protocol !== "https:" ||
      !(host === "zoom.us" || host.endsWith(".zoom.us") || host === "zoom.com" || host.endsWith(".zoom.com"))
    ) {
      res.status(400).json({ error: "Enter a secure Zoom recording link." });
      return;
    }

    if (!process.env.YCLOUD_API_KEY || !process.env.YCLOUD_FROM_NUMBER) {
      res.status(503).json({ error: "YCloud sending is not configured." });
      return;
    }
    const [request] = await db
      .select()
      .from(recordingRequestsTable)
      .where(eq(recordingRequestsTable.id, params.data.id))
      .limit(1);
    if (!request) {
      res.status(404).json({ error: "Recording request not found." });
      return;
    }
    if (request.status !== "pending") {
      res.status(409).json({ error: "This recording request has already been handled." });
      return;
    }

    const [latestInbound] = await db
      .select({ createdAt: conversationMessagesTable.createdAt })
      .from(conversationMessagesTable)
      .where(
        and(
          eq(conversationMessagesTable.phoneNumber, request.phoneNumber),
          eq(conversationMessagesTable.direction, "inbound"),
        ),
      )
      .orderBy(desc(conversationMessagesTable.createdAt))
      .limit(1);
    if (
      !latestInbound ||
      Date.now() - latestInbound.createdAt.getTime() > 24 * 60 * 60 * 1000
    ) {
      res.status(400).json({
        error: "The WhatsApp service window is closed. Ask the student to message again before sending the recording link.",
      });
      return;
    }

    const message = `ආයුබෝවන්, ඔබ ඉල්ලූ ${request.requestedDate} ${request.className && request.className !== "Unknown" ? request.className : request.classType ?? ""} පන්තියේ පටිගත කිරීම මෙන්න: ${body.data.zoomLink} ස්තූතියි.`;
    let providerMessageId: string | null;
    try {
      providerMessageId = await sendYCloudText(
        request.phoneNumber,
        message,
        `recording-request-${request.id}`,
      );
    } catch (error) {
      req.log.warn({ requestId: request.id }, "YCloud recording message failed");
      res.status(502).json({
        error: "YCloud did not accept the message. The request remains pending.",
      });
      return;
    }

    const [approved] = await db
      .update(recordingRequestsTable)
      .set({ status: "approved", zoomLink: body.data.zoomLink })
      .where(
        and(
          eq(recordingRequestsTable.id, request.id),
          eq(recordingRequestsTable.status, "pending"),
        ),
      )
      .returning();
    if (!approved) {
      res.status(409).json({ error: "This recording request was updated by another staff member." });
      return;
    }

    await db
      .insert(conversationsTable)
      .values({
        phoneNumber: request.phoneNumber,
        mode: "human",
        lastStaffMessageAt: new Date(),
        lastMessageAt: new Date(),
      })
      .onConflictDoUpdate({
        target: conversationsTable.phoneNumber,
        set: {
          mode: "human",
          lastStaffMessageAt: new Date(),
          lastMessageAt: new Date(),
        },
      });
    await db.insert(conversationMessagesTable).values({
      phoneNumber: request.phoneNumber,
      direction: "outbound",
      body: message,
      providerMessageId,
    }).onConflictDoNothing();

    res.json(
      ApproveRecordingRequestResponse.parse(serializeRecordingRequest(approved)),
    );
  },
);

export default router;
