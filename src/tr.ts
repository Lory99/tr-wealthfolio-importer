import type { ActivityImport } from "@wealthfolio/addon-sdk";

/** Raw Trade Republic CSV row (only the columns we use). */
export interface TradeRepublicCsvRecord {
  datetime: string;
  date: string;
  category: string;
  type: string;
  assetClass: string;
  name: string;
  /** ISIN in the TR export (`symbol` column). */
  symbol: string;
  shares: string;
  price: string;
  amount: string;
  fee: string;
  tax: string;
  currency: string;
  description: string;
  transactionId: string;
  lineNumber: number;
}

export interface TradeRepublicParseResult {
  rows: TradeRepublicCsvRecord[];
  transfers: TransferRecord[];
  skippedCash: number;
  skippedOther: number;
}

/** A cash transfer row (deposit/withdrawal) paired across two accounts. */
export interface TransferRecord {
  datetime: string;
  date: string;
  direction: "IN" | "OUT";
  amount: number | null;
  currency: string;
  description: string;
  transactionId: string;
  lineNumber: number;
}

function detectDelimiter(headerLine: string): string {
  const candidates = [";", ",", "\t"];
  let best = ";";
  let bestCount = -1;
  for (const d of candidates) {
    const count = headerLine.split(d).length;
    if (count > bestCount) {
      bestCount = count;
      best = d;
    }
  }
  return best;
}

/** Minimal RFC-4180-ish CSV splitter (quoted fields, escaped quotes). */
function splitLine(line: string, delimiter: string): string[] {
  const out: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === delimiter && !inQuotes) {
      out.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  out.push(current);
  return out.map((s) => s.trim());
}

const num = (v: string): number | null => {
  if (v === undefined || v === null) return null;
  const t = String(v).trim().replace(/\s/g, "");
  if (t === "" || t === "-") return null;
  const n = Number(t.replace(",", "."));
  return Number.isFinite(n) ? n : null;
};

/**
 * Parse a Trade Republic "Esportazione operazioni" / "Export transactions"
 * CSV. Keeps TRADING BUY/SELL rows plus CASH transfer rows (deposits and
 * withdrawals, inserted as transfer pairs). Other CASH rows (interest, …)
 * are skipped.
 */
export function parseTradeRepublicCsv(text: string): TradeRepublicParseResult {
  const normalized = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  const lines = normalized.split("\n").filter((l) => l.trim() !== "");
  if (lines.length < 2)
    return { rows: [], transfers: [], skippedCash: 0, skippedOther: 0 };

  const delimiter = detectDelimiter(lines[0]);
  const headers = splitLine(lines[0], delimiter).map((h) =>
    h.replace(/^"|"$/g, "").trim(),
  );
  const idx = (name: string) => headers.indexOf(name);

  const rows: TradeRepublicCsvRecord[] = [];
  const transfers: TransferRecord[] = [];
  let skippedCash = 0;
  let skippedOther = 0;

  for (let i = 1; i < lines.length; i++) {
    const cols = splitLine(lines[i], delimiter);
    const cell = (name: string) => {
      const j = idx(name);
      return j >= 0 && j < cols.length ? cols[j].replace(/^"|"$/g, "") : "";
    };
    const category = cell("category").toUpperCase();
    const type = cell("type").toUpperCase();

    if (category === "CASH") {
      if (type.includes("TRANSFER")) {
        const direction = type.includes("OUT") ? "OUT" : "IN";
        transfers.push({
          datetime: cell("datetime"),
          date: cell("date"),
          direction: direction as "IN" | "OUT",
          amount: num(cell("amount")),
          currency: cell("currency") || "EUR",
          description: cell("description"),
          transactionId: cell("transaction_id"),
          lineNumber: i,
        });
      } else {
        skippedCash++;
      }
      continue;
    }
    if (category !== "TRADING" || (type !== "BUY" && type !== "SELL")) {
      skippedOther++;
      continue;
    }
    rows.push({
      datetime: cell("datetime"),
      date: cell("date"),
      category: cell("category"),
      type: cell("type"),
      assetClass: cell("asset_class"),
      name: cell("name"),
      symbol: cell("symbol").toUpperCase().trim(),
      shares: cell("shares"),
      price: cell("price"),
      amount: cell("amount"),
      fee: cell("fee"),
      tax: cell("tax"),
      currency: cell("currency") || "EUR",
      description: cell("description"),
      transactionId: cell("transaction_id"),
      lineNumber: i,
    });
  }
  return { rows, transfers, skippedCash, skippedOther };
}

/** `ActivityImport` plus the ISIN the backend understands (SDK type omits it). */
export type ImportRow = ActivityImport & { isin?: string };

export interface MappedRow {
  record: TradeRepublicCsvRecord;
  draft: ImportRow;
  invalidReason: string | null;
}

const OPTION_TERMS = /\b(optionsscheine?|option(?:en|s)?|warrants?|call|put|opzion[ei]|opciones?)\b/i;
const DERIVATIVE_TERMS = /\b(derivative|optionsscheine?|option(?:en|s)?|warrants?|call|put|opzion[ei]|opciones?|factor|faktor|turbo|certificate|zertifikat)\b/i;
const UNIT_PRICED_CERTIFICATE_TERMS = /\b(derivative|optionsscheine?|warrants?|factor|faktor|turbo|certificate|zertifikat)\b/i;

/**
 * Wealthfolio's OPTION type defaults to a 100x multiplier. Trade Republic
 * warrants and leveraged certificates are priced per certificate, so keep
 * those on the 1x equity-like path unless the export identifies a true option
 * without certificate/derivative markers.
 */
export function inferTradeRepublicInstrumentType(
  record: TradeRepublicCsvRecord,
): string {
  const text = `${record.assetClass} ${record.name} ${record.description}`;
  if (UNIT_PRICED_CERTIFICATE_TERMS.test(text)) return "EQUITY";
  return OPTION_TERMS.test(text) ? "OPTION" : "EQUITY";
}

export function isTradeRepublicDerivative(record: TradeRepublicCsvRecord): boolean {
  return DERIVATIVE_TERMS.test(
    `${record.assetClass} ${record.name} ${record.description}`,
  );
}

/**
 * Map parsed TR rows to Wealthfolio `ActivityImport` drafts for one account.
 * Quantity is always positive (direction comes from BUY/SELL); fee/tax use
 * absolute values; the TR transaction id is embedded in `comment` for
 * traceability.
 */
export function mapToActivityImports(
  rows: TradeRepublicCsvRecord[],
  accountId: string,
): MappedRow[] {
  return rows.map((r, i) => {
    const activityType = r.type === "SELL" ? "SELL" : "BUY";
    const qty = num(r.shares);
    const price = num(r.price);
    const amount = num(r.amount);
    const fee = num(r.fee);
    const tax = num(r.tax);

    let invalidReason: string | null = null;
    if (!r.symbol) invalidReason = "Missing ISIN (symbol).";
    if (qty === null || Math.abs(qty) === 0)
      invalidReason = (invalidReason ?? "") + " Missing quantity.";
    if (!r.date && !r.datetime)
      invalidReason = (invalidReason ?? "") + " Missing date.";

    const date = r.datetime || (r.date ? `${r.date}T00:00:00.000Z` : "");
    const comment =
      `${r.description}${r.transactionId ? ` [TR:${r.transactionId}]` : ""}`.trim();

    const draft: ImportRow = {
      accountId,
      activityType: activityType as ActivityImport["activityType"],
      date,
      symbol: r.symbol || undefined,
      isin: r.symbol || undefined,
      symbolName: r.name || undefined,
      quantity: qty === null ? null : Math.abs(qty),
      unitPrice: price,
      amount,
      fee: fee === null ? null : Math.abs(fee),
      tax: tax === null ? null : Math.abs(tax),
      currency: r.currency || "EUR",
      comment: comment || undefined,
      lineNumber: i + 1,
      isValid: invalidReason === null,
      isDraft: true,
    };
    return { record: r, draft, invalidReason };
  });
}
