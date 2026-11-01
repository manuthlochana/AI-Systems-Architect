import { EventEmitter } from "node:events";
import { Redis } from "ioredis";
import { logger } from "./logger";

/**
 * Tiny key-value facade used for the admin sliding lock and the burst buffer.
 * Uses Redis when REDIS_URL is set; otherwise (or if Redis errors) an in-process
 * Map with TTLs, so a Redis outage never crashes webhook processing.
 */

interface MemEntry {
  value: string | string[];
  expiresAt: number;
}

const memory = new Map<string, MemEntry>();

function memGet(key: string): MemEntry | undefined {
  const entry = memory.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    memory.delete(key);
    return undefined;
  }
  return entry;
}

let client: Redis | null = null;
let redisHealthy = false;

function getClient(): Redis | null {
  if (!process.env.REDIS_URL) return null;
  if (client) return client;
  client = new Redis(process.env.REDIS_URL, {
    maxRetriesPerRequest: 2,
    enableOfflineQueue: false,
    retryStrategy: (times) => Math.min(times * 500, 5_000),
  });
  client.on("ready", () => {
    redisHealthy = true;
    logger.info("Redis connected");
  });
  client.on("error", (err: Error) => {
    if (redisHealthy) logger.warn({ err: err.message }, "Redis error; using in-memory fallback");
    redisHealthy = false;
  });
  client.on("end", () => {
    redisHealthy = false;
  });
  return client;
}

export function kvBackend(): "redis" | "memory" {
  return getClient() && redisHealthy ? "redis" : "memory";
}

async function withRedis<T>(op: (r: Redis) => Promise<T>): Promise<T | undefined> {
  const r = getClient();
  if (!r || !redisHealthy) return undefined;
  try {
    return await op(r);
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "Redis op failed; falling back");
    return undefined;
  }
}

export async function kvGet(key: string): Promise<string | null> {
  const viaRedis = await withRedis((r) => r.get(key));
  if (viaRedis !== undefined) return viaRedis;
  const entry = memGet(key);
  return typeof entry?.value === "string" ? entry.value : null;
}

/** SET key value EX ttlSeconds (resets TTL on every call = rolling window). */
export async function kvSet(key: string, value: string, ttlSeconds: number): Promise<void> {
  memory.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
  await withRedis((r) => r.set(key, value, "EX", ttlSeconds));
}

export async function kvDel(key: string): Promise<void> {
  memory.delete(key);
  await withRedis((r) => r.del(key));
}

export async function kvPush(key: string, value: string, ttlSeconds: number): Promise<void> {
  const entry = memGet(key);
  const list = Array.isArray(entry?.value) ? entry.value : [];
  list.push(value);
  memory.set(key, { value: list, expiresAt: Date.now() + ttlSeconds * 1000 });
  await withRedis(async (r) => {
    await r.multi().rpush(key, value).expire(key, ttlSeconds).exec();
  });
}

/** Atomically reads and clears a list. */
export async function kvDrain(key: string): Promise<string[]> {
  const entry = memGet(key);
  const local = Array.isArray(entry?.value) ? entry.value : [];
  memory.delete(key);
  const viaRedis = await withRedis(async (r) => {
    const res = await r.multi().lrange(key, 0, -1).del(key).exec();
    const items = res?.[0]?.[1];
    return Array.isArray(items) ? (items as string[]) : [];
  });
  return viaRedis && viaRedis.length ? viaRedis : local;
}

/** Process-wide event bus; the SSE endpoint relays these to open dashboards. */
export const dashboardEvents = new EventEmitter();
dashboardEvents.setMaxListeners(50);

export function emitDashboardEvent(type: string, data: Record<string, unknown> = {}): void {
  dashboardEvents.emit("event", { type, ...data, at: new Date().toISOString() });
}

// Connect eagerly so the first lock/buffer operation already uses Redis.
getClient();
