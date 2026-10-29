/**
 * Minimal CSV parser (spec 6: Google Sheets / CSV import of old leads + sales).
 * No dependency — handles the common cases: quoted fields, embedded commas,
 * embedded newlines, escaped double-quotes. Returns an array of row objects
 * keyed by the header row, which the import screen maps to phone/email/amount.
 */

/** Extract the raw 2D row array (for the import screen to map columns). */
export function splitCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  const s = text.replace(/\r\n/g, "\n");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field); field = "";
    } else if (c === "\n") {
      row.push(field); rows.push(row); row = []; field = "";
    } else field += c;
  }
  row.push(field);
  if (row.length > 1 || row[0] !== "") rows.push(row);
  return rows;
}

/** Parse CSV text into objects keyed by the header row. */
export function parseCsv(text: string): Record<string, string>[] {
  const rows = splitCsv(text);
  if (rows.length === 0) return [];
  const header = rows[0]!;
  return rows.slice(1).map((r) => {
    const obj: Record<string, string> = {};
    header.forEach((h, i) => (obj[h] = r[i] ?? ""));
    return obj;
  });
}

/** Column mapping for an import (spec 6: "upload with column mapping"). */
export interface ColumnMap {
  phone?: string;
  email?: string;
  name?: string;
  city?: string;
  amount?: string;
  status?: string;
  product?: string;
}
