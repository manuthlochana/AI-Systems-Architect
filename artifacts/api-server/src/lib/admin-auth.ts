import { createHmac, timingSafeEqual } from "node:crypto";
import type { Request, RequestHandler, Response } from "express";

const COOKIE_NAME = "al_media_admin";
const SESSION_DURATION_MS = 12 * 60 * 60 * 1000;

function sessionSecret(): string | undefined {
  return process.env.SESSION_SECRET;
}

function signature(expiresAt: string): Buffer | null {
  const secret = sessionSecret();
  if (!secret) return null;
  return createHmac("sha256", secret)
    .update(`al-media-admin:${expiresAt}`)
    .digest();
}

function cookieValue(req: Request): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === COOKIE_NAME) {
      try {
        return decodeURIComponent(part.slice(separator + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}

export function isAdminKeyConfigured(): boolean {
  return Boolean(process.env.ADMIN_API_KEY);
}

export function isAdminSessionConfigured(): boolean {
  return Boolean(sessionSecret());
}

export function isAdminAuthenticated(req: Request): boolean {
  const token = cookieValue(req);
  if (!token) return false;

  const separator = token.indexOf(".");
  if (separator < 1) return false;
  const expiresAt = token.slice(0, separator);
  const providedSignature = token.slice(separator + 1);
  if (!/^\d{13}$/.test(expiresAt) || !/^[a-f0-9]{64}$/i.test(providedSignature)) {
    return false;
  }
  if (Number(expiresAt) <= Date.now()) return false;

  const expectedSignature = signature(expiresAt);
  if (!expectedSignature) return false;
  const actualSignature = Buffer.from(providedSignature, "hex");
  return (
    actualSignature.length === expectedSignature.length &&
    timingSafeEqual(actualSignature, expectedSignature)
  );
}

export function matchesAdminKey(candidate: string): boolean {
  const expected = process.env.ADMIN_API_KEY;
  if (!expected) return false;
  const candidateDigest = createHmac("sha256", "al-media-admin-key-check")
    .update(candidate)
    .digest();
  const expectedDigest = createHmac("sha256", "al-media-admin-key-check")
    .update(expected)
    .digest();
  return timingSafeEqual(candidateDigest, expectedDigest);
}

export function setAdminSessionCookie(res: Response): void {
  const expiresAt = String(Date.now() + SESSION_DURATION_MS);
  const signed = signature(expiresAt);
  if (!signed) throw new Error("SESSION_SECRET is not configured");
  const token = `${expiresAt}.${signed.toString("hex")}`;
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.setHeader(
    "Set-Cookie",
    `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(SESSION_DURATION_MS / 1000)}${secure}`,
  );
}

export function clearAdminSessionCookie(res: Response): void {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.setHeader(
    "Set-Cookie",
    `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`,
  );
}

export const requireAdmin: RequestHandler = (req, res, next) => {
  if (!isAdminAuthenticated(req)) {
    res.status(401).json({ error: "Admin session required" });
    return;
  }
  next();
};
