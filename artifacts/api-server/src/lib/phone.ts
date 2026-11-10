export function normalizePhoneNumber(value: string): string {
  const cleaned = String(value ?? "")
    .trim()
    .replace(/\.0+$/, "")
    .replace(/[()\s.-]/g, "");
  if (/^0\d{9}$/.test(cleaned)) return `+94${cleaned.slice(1)}`;
  if (/^94\d{9}$/.test(cleaned)) return `+${cleaned}`;
  if (/^\+\d{8,15}$/.test(cleaned)) return cleaned;
  throw new Error("Enter a valid phone number in 07XXXXXXXX or E.164 format");
}

/**
  * Canonical phone sanitizer: Strips all non-digit characters and extracts strictly the last 9 digits.
  * e.g., '+94 77 123 4567', '0771234567', '94771234567', '771234567.0' -> '771234567'
  */
export function sanitizePhone9Digits(value: string | number | null | undefined): string {
  if (value === null || value === undefined) {
    throw new Error("Phone number is required");
  }
  const str = String(value).trim().replace(/\.0+$/, "");
  const digits = str.replace(/\D/g, "");
  const match = /(\d{9})$/.exec(digits);
  if (!match) {
    throw new Error(`Phone number "${value}" must contain at least 9 digits`);
  }
  return match[1];
}

export function trySanitizePhone9Digits(value: string | number | null | undefined): string | null {
  try {
    return sanitizePhone9Digits(value);
  } catch {
    return null;
  }
}

export const toPhoneKey = sanitizePhone9Digits;
export const tryPhoneKey = trySanitizePhone9Digits;
