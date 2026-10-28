import fs from "node:fs";
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
} from "@workspace/api-zod";
import {
  conversationMessagesTable,
  conversationsTable,
  db,
  dynamicContentTable,
  recordingRequestsTable,
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
import { isYCloudConfigured, sendYCloudText } from "../lib/ycloud";
import { readKnowledgeBase, writeKnowledgeBase } from "../lib/ai-agent";

const router: IRouter = Router();
const loginAttempts = new Map<string, { count: number; resetAt: number }>();

function serializeConversation(
  row: typeof conversationsTable.$inferSelect & { lastMessage: string | null },
) {
  return {
    ...row,
    lastMessageAt: row.lastMessageAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
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

  res.json(GetConversationsResponse.parse(rows.map(serializeConversation)));
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
      .set({ mode: body.data.mode, lastMessageAt: new Date() })
      .where(eq(conversationsTable.phoneNumber, params.data.phoneNumber))
      .returning();
    if (!conversation) {
      res.status(404).json({ error: "Conversation not found" });
      return;
    }
    const [lastMessage] = await db
      .select({ body: conversationMessagesTable.body })
      .from(conversationMessagesTable)
      .where(eq(conversationMessagesTable.phoneNumber, conversation.phoneNumber))
      .orderBy(desc(conversationMessagesTable.createdAt))
      .limit(1);

    res.json(
      SetConversationModeResponse.parse(
        serializeConversation({ ...conversation, lastMessage: lastMessage?.body ?? null }),
      ),
    );
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
      .set({ mode, lastMessageAt: new Date() })
      .where(eq(conversationsTable.phoneNumber, phoneToUpdate))
      .returning();

    if (!conversation) {
      res.status(404).json({ error: "Conversation not found" });
      return;
    }

    const [lastMessage] = await db
      .select({ body: conversationMessagesTable.body })
      .from(conversationMessagesTable)
      .where(eq(conversationMessagesTable.phoneNumber, conversation.phoneNumber))
      .orderBy(desc(conversationMessagesTable.createdAt))
      .limit(1);

    res.json(
      SetConversationModeResponse.parse(
        serializeConversation({ ...conversation, lastMessage: lastMessage?.body ?? null }),
      ),
    );
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

    const message = `ආයුබෝවන් පුතේ, ඔබ ඉල්ලූ ${request.requestedDate} ${request.className && request.className !== "Unknown" ? request.className : request.classType ?? ""} පන්තියේ පටිගත කිරීම මෙන්න: ${body.data.zoomLink} ස්තූතියි පුතේ.`;
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
      .values({ phoneNumber: request.phoneNumber, mode: "bot" })
      .onConflictDoUpdate({
        target: conversationsTable.phoneNumber,
        set: { lastMessageAt: new Date() },
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
