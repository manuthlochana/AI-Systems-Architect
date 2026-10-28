import * as XLSX from "xlsx";

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const ALLOWED_EXTENSIONS = new Set([".csv", ".xlsx"]);

export interface TuteDeliveryColumnMap {
  phoneNumber: string;
  studentName: string;
  trackingNumber: string;
  address: string;
}

export interface SpreadsheetRow {
  [column: string]: string;
}

export interface ParsedSpreadsheet {
  columns: string[];
  rows: SpreadsheetRow[];
}

export function decodeSpreadsheet(fileName: string, fileData: string): Buffer {
  const extension = fileName.toLowerCase().slice(fileName.lastIndexOf("."));
  if (!ALLOWED_EXTENSIONS.has(extension)) {
    throw new Error("Choose an .xlsx or .csv file");
  }
  if (!fileData || fileData.length > 15_000_000) {
    throw new Error("The spreadsheet is empty or too large");
  }

  const normalized = fileData.replace(/\s/g, "");
  if (!/^[a-zA-Z0-9+/]*={0,2}$/.test(normalized)) {
    throw new Error("The spreadsheet data is not valid base64");
  }
  const buffer = Buffer.from(normalized, "base64");
  if (
    buffer.length === 0 ||
    buffer.length > MAX_FILE_BYTES ||
    buffer.toString("base64").replace(/=+$/, "") !== normalized.replace(/=+$/, "")
  ) {
    throw new Error("The spreadsheet must be smaller than 10 MB");
  }
  return buffer;
}

export function parseSpreadsheet(fileName: string, fileData: string): ParsedSpreadsheet {
  const buffer = decodeSpreadsheet(fileName, fileData);
  const workbook = XLSX.read(buffer, { type: "buffer", raw: false });
  const firstSheetName = workbook.SheetNames[0];
  if (!firstSheetName) throw new Error("The spreadsheet does not contain a worksheet");
  const sheet = workbook.Sheets[firstSheetName];
  const sourceRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
    defval: "",
    raw: false,
  });
  const columns = sourceRows.length
    ? Object.keys(sourceRows[0])
    : XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1, blankrows: false })[0] ?? [];
  const rows = sourceRows.map((row) =>
    Object.fromEntries(
      columns.map((column) => {
        let val = String(row[column] ?? "").trim();
        // Strip trailing float zeroes (e.g. 772994218.0 or 772994218.00 from Excel numeric cells)
        val = val.replace(/\.0+$/, "");
        return [column, val];
      }),
    ),
  );
  return { columns, rows };
}

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

// Aliases for backwards compatibility
export const toPhoneKey = sanitizePhone9Digits;
export const tryPhoneKey = trySanitizePhone9Digits;

export function deliveryColumnMapFromHeaders(columns: string[]): TuteDeliveryColumnMap {
  const normalized = new Map(columns.map((column) => [column.toLowerCase().replace(/[^a-z0-9]/g, ""), column]));
  const find = (candidates: string[], fallbackIndex: number): string =>
    candidates.map((candidate) => normalized.get(candidate)).find(Boolean) ??
    columns[fallbackIndex] ??
    "";

  return {
    phoneNumber: find(["city1", "phonenumber", "phone", "mobile", "contactnumber", "whatsapp", "city"], 0),
    studentName: find(["name", "studentname", "student"], 1),
    trackingNumber: find(["regno", "trackingno", "trackingnumber", "tracking", "waybill"], 2),
    address: find(["address1", "address", "postaladdress"], 3),
  };
}
