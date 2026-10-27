import { createHmac, timingSafeEqual } from "node:crypto";

export function verifyYCloudSignature(
  rawBody: Buffer,
  header: string | undefined,
  secret: string | undefined,
  now = Date.now(),
): boolean {
  if (!header || !secret || !Buffer.isBuffer(rawBody)) return false;

  let timestamp: string | undefined;
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const [key, value] = part.trim().split("=", 2);
    if (key === "t") {
      if (timestamp !== undefined) return false;
      timestamp = value;
    } else if (key === "s" && value) {
      signatures.push(value);
    }
  }

  if (!timestamp || !/^\d{1,12}$/.test(timestamp)) return false;
  if (Math.abs(Math.floor(now / 1000) - Number(timestamp)) > 300) return false;

  const expected = createHmac("sha256", secret)
    .update(`${timestamp}.`)
    .update(rawBody)
    .digest();

  return signatures.some((candidate) => {
    if (!/^[a-f0-9]{64}$/i.test(candidate)) return false;
    const supplied = Buffer.from(candidate, "hex");
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
  });
}
