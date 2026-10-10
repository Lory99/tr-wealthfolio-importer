import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type {
  Account,
  AddonContext,
  ImportActivitiesResult,
} from "@wealthfolio/addon-sdk";
import {
  Badge,
  Button,
  Card,
  CardContent,
  Checkbox,
  Input,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@wealthfolio/ui";
import {
  mapToActivityImports,
  parseTradeRepublicCsv,
  inferTradeRepublicInstrumentType,
  isTradeRepublicDerivative,
  type ImportRow,
  type MappedRow,
  type TransferRecord,
} from "./tr";

const STORAGE_KEY_ACCOUNT = "last-account-v1";
const STORAGE_KEY_COUNTER = "counter-account-v1";

interface MarketResolution {
  source: "STANDARD" | "MANUAL";
  symbol: string;
  symbolName?: string;
  exchangeMic?: string;
  quoteCcy: string;
  instrumentType: string;
  quoteMode: "MARKET" | "MANUAL";
  providerId?: string;
  providerSymbol?: string;
  label: string;
}

export interface TransferPreview {
  record: TransferRecord;
  /** LEG key for selection state (record.lineNumber). */
  selected: boolean;
  /** Duplicate reason, or null when insertable. */
  duplicateOf: string | null;
}

const dayOf = (t: TransferRecord) =>
  new Date(t.datetime || `${t.date}T00:00:00.000Z`).toISOString().slice(0, 10);

const sameDay = (a: Date | string, day: string) =>
  new Date(a).toISOString().slice(0, 10) === day;

type Step = "account" | "file" | "resolution" | "review" | "done";

interface CheckedRow {
  key: number;
  mapped: MappedRow;
  resolution: MarketResolution;
  /** Backend echo from checkImport (dup markers, validity, assetId...). */
  checked: ImportRow | null;
  checkError: string | null;
  selected: boolean;
  forced: boolean;
}

const fmt = (v: number | string | null | undefined) =>
  v === null || v === undefined || v === "" ? "—" : String(v);

function isDuplicate(r: CheckedRow): boolean {
  const c = r.checked as (ImportRow & {
    duplicateOfId?: string;
    duplicateOfLineNumber?: number;
  }) | null;
  return !!c && (c.duplicateOfId != null || c.duplicateOfLineNumber != null);
}

function getTradeRepublicTransactionId(
  comment?: string | null,
  sourceRecordId?: string | null,
): string | null {
  const directId = sourceRecordId?.trim();
  if (directId) return directId.toLowerCase();
  const match = comment?.match(/\[TR:([^\]]+)\]/i);
  return match?.[1]?.trim().toLowerCase() || null;
}

export function TradeRepublicImporter({ ctx }: { ctx: AddonContext }) {
  const [step, setStep] = useState<Step>("account");
  const [accountId, setAccountId] = useState<string>("");
  const [parsed, setParsed] = useState<MappedRow[] | null>(null);
  const [parseNote, setParseNote] = useState("");
  const [resolutions, setResolutions] = useState<Record<string, MarketResolution>>(
    {},
  );
  const [resolving, setResolving] = useState(false);
  const [invalidNotes, setInvalidNotes] = useState<Record<string, string>>({});
  const [rows, setRows] = useState<CheckedRow[]>([]);
  const [checking, setChecking] = useState(false);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<ImportActivitiesResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const accountsQuery = useQuery({
    queryKey: ["tr-importer", "accounts"],
    queryFn: () => ctx.api.accounts.getAll(),
  });

  // Restore the last selected accounts.
  useEffect(() => {
    ctx.api.storage.get(STORAGE_KEY_ACCOUNT).then((v) => {
      if (v) setAccountId(v);
    }).catch(() => undefined);
    ctx.api.storage.get(STORAGE_KEY_COUNTER).then((v) => {
      if (v) setCounterpartyAccountId(v);
    }).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const accounts = useMemo(
    () => (accountsQuery.data ?? []) as Account[],
    [accountsQuery.data],
  );
  const account = accounts.find((a) => a.id === accountId);

  const distinctIsins = useMemo(() => {
    const set = new Map<string, string>();
    for (const m of parsed ?? []) {
      if (m.draft.isin) set.set(m.draft.isin, m.record.name);
    }
    return [...set.entries()];
  }, [parsed]);

  const counts = useMemo(() => {
    const total = rows.length;
    const dups = rows.filter(isDuplicate).length;
    const invalid = rows.filter(
      (r) => (r.checkError || (r.checked && !r.checked.isValid)) && !isDuplicate(r),
    ).length;
    const selected = rows.filter((r) => r.selected).length;
    return { total, dups, invalid, selected };
  }, [rows]);

  async function pickAccount(id: string) {
    setAccountId(id);
    setStep("file");
    try {
      await ctx.api.storage.set(STORAGE_KEY_ACCOUNT, id);
    } catch {
      // non-fatal
    }
  }

  async function pickCounterparty(id: string) {
    setCounterpartyAccountId(id);
    try {
      await ctx.api.storage.set(STORAGE_KEY_COUNTER, id);
    } catch {
      // non-fatal
    }
  }

  /**
   * Duplicate check for transfer legs against existing TRANSFER_OUT /
   * TRANSFER_IN activities (same day + same absolute amount on the leg's
   * account). Either leg matching marks the whole pair as duplicate.
   */
  async function detectTransferDuplicates(
    list: TransferPreview[],
    targetId: string,
    counterId: string,
  ): Promise<TransferPreview[]> {
    let targetActs: Awaited<ReturnType<typeof ctx.api.activities.getAll>> = [];
    let counterActs: Awaited<ReturnType<typeof ctx.api.activities.getAll>> = [];
    let allActs: Awaited<ReturnType<typeof ctx.api.activities.getAll>> = [];
    try {
      [targetActs, counterActs, allActs] = await Promise.all([
        ctx.api.activities.getAll(targetId),
        ctx.api.activities.getAll(counterId),
        ctx.api.activities.getAll(),
      ]);
    } catch (e) {
      ctx.api.logger.error(`TR transfer dup check failed: ${String(e)}`);
      return list;
    }
    const hasLeg = (
      acts: typeof targetActs,
      type: string,
      day: string,
      amount: number,
    ) =>
      acts.some(
        (a) =>
          a.activityType === type &&
          sameDay(a.date, day) &&
          a.amount !== null &&
          Math.round(Math.abs(Number(a.amount)) * 100) ===
            Math.round(Math.abs(amount) * 100),
      );
    const seenTransactionIds = new Map<string, number>();
    return list.map((t) => {
      const amt = t.record.amount;
      if (amt === null) return { ...t, selected: false, duplicateOf: "Missing amount." };
      const day = dayOf(t.record);
      const fromActs = t.record.direction === "IN" ? counterActs : targetActs;
      const toActs = t.record.direction === "IN" ? targetActs : counterActs;
      const transactionId = t.record.transactionId.trim().toLowerCase();
      const priorLineNumber = transactionId
        ? seenTransactionIds.get(transactionId)
        : undefined;
      if (transactionId && priorLineNumber === undefined) {
        seenTransactionIds.set(transactionId, t.record.lineNumber);
      }
      const hasTransaction = (acts: typeof targetActs) =>
        !!transactionId &&
        acts.some(
          (a) =>
            getTradeRepublicTransactionId(a.comment, a.sourceRecordId) ===
            transactionId,
        );
      const transactionMatch = hasTransaction(allActs);
      const outMatch =
        transactionMatch || hasTransaction(fromActs) || hasLeg(fromActs, "TRANSFER_OUT", day, amt);
      const inMatch =
        transactionMatch || hasTransaction(toActs) || hasLeg(toActs, "TRANSFER_IN", day, amt);
      if (outMatch || inMatch) {
        return {
          ...t,
          selected: false,
          duplicateOf: `Matches existing ${outMatch ? "TRANSFER_OUT" : ""}${outMatch && inMatch ? "/" : ""}${inMatch ? "TRANSFER_IN" : ""} on ${day}.`,
        };
      }
      if (priorLineNumber !== undefined) {
        return {
          ...t,
          selected: false,
          duplicateOf: `Repeats deposit from line ${priorLineNumber} in this CSV.`,
        };
      }
      return { ...t, duplicateOf: null };
    });
  }

  async function onFile(file: File) {
    setError(null);
    try {
      const text = await file.text();
      const {
        rows: recs,
        transfers: parsedTransfers,
        skippedCash,
        skippedOther,
      } = parseTradeRepublicCsv(text);
      if (!accountId) {
        setError("Pick a target account first.");
        setStep("account");
        return;
      }
      const mapped = mapToActivityImports(recs, accountId);
      setParsed(mapped);
      setTransfers(
        parsedTransfers.map((t) => ({
          record: t,
          selected: t.amount !== null && Math.abs(t.amount) > 0,
          duplicateOf: null,
        })),
      );
      setTransferErrors([]);
      setTransfersCreated(0);
      setParseNote(
        `${mapped.length} trading rows · ${parsedTransfers.length} transfers · skipped ${skippedCash} cash + ${skippedOther} other`,
      );
      setStep("resolution");
      void resolveAll(mapped);
    } catch (e) {
      setError(`Could not read CSV: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** Resolve plain stocks through Wealthfolio's standard providers. */
  async function resolveAll(mapped: MappedRow[]) {
    setResolving(true);
    setError(null);
    try {
      const info = new Map<
        string,
        { name: string; stock: boolean; instrumentType: string }
      >();
      for (const m of mapped) {
        if (!m.draft.isin) continue;
        const isStock = !isTradeRepublicDerivative(m.record);
        const instrumentType = inferTradeRepublicInstrumentType(m.record);
        const prev = info.get(m.draft.isin);
        info.set(m.draft.isin, {
          name: m.record.name,
          stock: (prev?.stock ?? false) || isStock,
          instrumentType:
            instrumentType === "OPTION" || prev?.instrumentType === "OPTION"
              ? "OPTION"
              : "EQUITY",
        });
      }
      const out: Record<string, MarketResolution> = {};
      const invalid: Record<string, string> = {};

      // Plain stocks use Wealthfolio's standard market providers.
      const stockIsins = [...info.entries()].filter(([, v]) => v.stock);
      if (stockIsins.length > 0) {
        const drafts = stockIsins.map(([isin]) => {
          const m = mapped.find((x) => x.draft.isin === isin)!;
          return {
            ...m.draft,
            accountId,
            quoteMode: "MARKET",
            exchangeMic: undefined,
            providerId: undefined,
            providerSymbol: undefined,
          } as ImportRow;
        });
        let echoed: ImportRow[] = [];
        try {
          echoed = (await ctx.api.activities.checkImport(
            drafts as Parameters<typeof ctx.api.activities.checkImport>[0],
          )) as ImportRow[];
        } catch (e) {
          throw new Error(
            `Standard-market lookup failed: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
        echoed.forEach((c, i) => {
          const [isin] = stockIsins[i];
          const errs = (c as unknown as { errors?: Record<string, string[]> }).errors;
          if (c.isValid !== false && c.exchangeMic) {
            out[isin] = {
              source: "STANDARD",
              symbol: c.symbol ?? isin,
              symbolName: c.symbolName ?? info.get(isin)?.name,
              exchangeMic: c.exchangeMic,
              quoteCcy: c.quoteCcy ?? c.currency ?? "EUR",
              instrumentType: c.instrumentType ?? "EQUITY",
              quoteMode: "MARKET",
              providerId: c.providerId ?? undefined,
              providerSymbol: c.providerSymbol ?? undefined,
              label: `${c.exchangeMic} · ${c.providerId ?? "standard"}`,
            };
          } else if (c.isValid !== false && c.assetId) {
            out[isin] = {
              source: "MANUAL",
              symbol: c.symbol ?? isin,
              symbolName: c.symbolName ?? info.get(isin)?.name,
              exchangeMic: c.exchangeMic,
              quoteCcy: c.quoteCcy ?? c.currency ?? "EUR",
              instrumentType: c.instrumentType ?? "EQUITY",
              quoteMode: c.quoteMode === "MARKET" ? "MARKET" : "MANUAL",
              providerId: c.providerId ?? undefined,
              providerSymbol: c.providerSymbol ?? undefined,
              label: `${c.exchangeMic ?? "?"} · existing security`,
            };
          } else if (!errs?.symbol?.length) {
            invalid[isin] =
              errs?.symbol?.join(" ") ??
              Object.values(errs ?? {}).flat().join(" ") ??
              "Rejected by standard-market lookup.";
          }
          // Otherwise the row remains a manual security.
        });
      }

      // Derivatives and standard-provider misses stay manual.
      for (const [isin, v] of info) {
        if (out[isin] || invalid[isin]) continue;
        out[isin] = {
          source: "MANUAL",
          symbol: isin,
          symbolName: v.name,
          quoteCcy: "EUR",
          instrumentType: v.instrumentType,
          quoteMode: "MANUAL",
          providerSymbol: isin,
          label: "MANUAL · no standard quote",
        };
      }
      setInvalidNotes(invalid);
      setResolutions(out);
    } catch (e) {
      setError(`Market resolution failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setResolving(false);
    }
  }

  function applyResolution(m: MappedRow): ImportRow {
    const isin = m.draft.isin ?? "";
    const r = resolutions[isin];
    return {
      ...m.draft,
      accountId,
      // `m.draft.isDraft` is for the review/checkImport phase only. The
      // final import must create posted activities so they affect holdings.
      isDraft: false,
      symbol: r?.symbol ?? m.draft.symbol,
      symbolName: r?.symbolName ?? m.draft.symbolName,
      exchangeMic: r?.exchangeMic,
      quoteCcy: r?.quoteCcy ?? m.draft.currency ?? "EUR",
      instrumentType: r?.instrumentType ?? "EQUITY",
      quoteMode: r?.quoteMode ?? "MANUAL",
      providerId: r?.providerId,
      // Preserve the provider-specific symbol returned by market resolution.
      // The activity's ISIN identifies the security, but is not necessarily
      // the symbol the quote provider (for example Yahoo) accepts.
      providerSymbol:
        r?.providerSymbol || r?.symbol || (m.draft.isin ?? "").toUpperCase(),
    } as ImportRow;
  }

  /** Run backend duplicate check; duplicates are auto-disabled. */
  async function onCheck() {
    if (!parsed) return;
    if (transfers.length > 0 && !counterpartyAccountId) {
      setError("Pick the counterparty account for the cash transfers first.");
      return;
    }
    setChecking(true);
    setError(null);
    try {
      if (transfers.length > 0) {
        setTransfers(
          await detectTransferDuplicates(transfers, accountId, counterpartyAccountId),
        );
      }
      // checkImport expects preview rows. applyResolution also prepares rows
      // for the final insert, so restore draft mode for the duplicate check.
      const drafts = parsed.map((m) => ({ ...applyResolution(m), isDraft: true }));
      const checked = await ctx.api.activities.checkImport(
        drafts as Parameters<typeof ctx.api.activities.checkImport>[0],
      );
      // Wealthfolio's fingerprint check can miss transactions imported before
      // final-cash normalization. Trade Republic provides a stable transaction
      // ID, and earlier addon imports preserve it in the activity comment.
      // A broker transaction remains the same transaction if the user has
      // since moved it to another account, so inspect the full activity list.
      const existingActivities = await ctx.api.activities.getAll();
      const existingByTransactionId = new Map<string, string>();
      for (const activity of existingActivities) {
        const transactionId = getTradeRepublicTransactionId(
          activity.comment,
          activity.sourceRecordId,
        );
        if (transactionId && !existingByTransactionId.has(transactionId)) {
          existingByTransactionId.set(transactionId, activity.id);
        }
      }
      const seenTransactionIds = new Map<string, number>();
      const next: CheckedRow[] = parsed.map((m, i) => {
        const checkedActivity = (checked[i] ?? null) as ImportRow | null;
        const transactionId = m.record.transactionId.trim().toLowerCase();
        const existingActivityId = transactionId
          ? existingByTransactionId.get(transactionId)
          : undefined;
        const priorLineNumber = transactionId
          ? seenTransactionIds.get(transactionId)
          : undefined;
        if (transactionId && priorLineNumber === undefined) {
          seenTransactionIds.set(transactionId, m.record.lineNumber);
        }
        const c = existingActivityId
          ? {
              ...(checkedActivity ?? applyResolution(m)),
              duplicateOfId: existingActivityId,
            }
          : priorLineNumber !== undefined
            ? {
                ...(checkedActivity ?? applyResolution(m)),
                duplicateOfLineNumber: priorLineNumber,
              }
          : checkedActivity;
        const dup =
          !!existingActivityId ||
          priorLineNumber !== undefined ||
          (!!c &&
            (c.duplicateOfId != null || c.duplicateOfLineNumber != null));
        const invalidReason =
          m.invalidReason ?? invalidNotes[m.draft.isin ?? ""] ?? null;
        const valid = invalidReason === null && (c ? c.isValid !== false : true);
        return {
          key: i,
          mapped: m,
          resolution: resolutions[m.draft.isin ?? ""] ?? {
            source: "MANUAL",
            symbol: m.draft.isin ?? "",
            quoteCcy: "EUR",
            instrumentType: "EQUITY",
            quoteMode: "MANUAL",
            label: "MANUAL · unresolved",
          },
          checked: c,
          checkError: invalidReason,
          selected: valid && !dup,
          forced: false,
        };
      });
      setRows(next);
      setStep("review");
    } catch (e) {
      setError(`Duplicate check failed: ${e instanceof Error ? e.message : String(e)}`);
      ctx.api.logger.error(`TR checkImport failed: ${String(e)}`);
    } finally {
      setChecking(false);
    }
  }

  function toggleRow(key: number, on: boolean) {
    setRows((prev) =>
      prev.map((r) => (r.key === key ? { ...r, selected: on } : r)),
    );
  }

  function toggleForce(key: number) {
    setRows((prev) =>
      prev.map((r) => {
        if (r.key !== key) return r;
        const forced = !r.forced;
        const c = r.checked
          ? ({ ...r.checked, forceImport: forced } as ImportRow)
          : r.checked;
        return { ...r, forced, checked: c, selected: forced ? true : r.selected };
      }),
    );
  }

  const [counterpartyAccountId, setCounterpartyAccountId] = useState<string>("");
  const [transfers, setTransfers] = useState<TransferPreview[]>([]);
  const [transfersCreated, setTransfersCreated] = useState(0);
  const [transferErrors, setTransferErrors] = useState<string[]>([]);

  async function onImport() {
    const toImport = rows.filter((r) => r.selected);
    const pendingTransfers = transfers.filter((t) => t.selected && !t.duplicateOf);
    if (toImport.length === 0 && pendingTransfers.length === 0) {
      setError("Nothing selected to import.");
      return;
    }
    setImporting(true);
    setError(null);
    try {
      const payload = toImport.map((r) => applyResolution(r.mapped));
      // carry forceImport for rows the user explicitly forced
      toImport.forEach((r, i) => {
        if (r.forced) {
          (payload[i] as ImportRow & { forceImport?: boolean }).forceImport = true;
        }
      });
      let importedSummary: string | null = null;
      if (payload.length > 0) {
      const res = await ctx.api.activities.import(
        payload as Parameters<typeof ctx.api.activities.import>[0],
      );
      setResult(res);
      importedSummary = `${res.summary.imported}/${res.summary.total}`;
      } // end payload.length > 0

      // Cash transfer pairs (deposit at the beginning, etc.): one
      // TRANSFER_OUT + TRANSFER_IN pair per selected transfer. Failures are
      // collected per transfer and never fail the securities import.
      const pending = transfers.filter((t) => t.selected && !t.duplicateOf);
      let created = 0;
      const tErrors: string[] = [];
      if (pending.length > 0 && counterpartyAccountId) {
        const target = accounts.find((a) => a.id === accountId);
        const counter = accounts.find((a) => a.id === counterpartyAccountId);
        for (const t of pending) {
          const amt = t.record.amount;
          if (amt === null) {
            tErrors.push(`Line ${t.record.lineNumber}: missing amount.`);
            continue;
          }
          const fromId =
            t.record.direction === "IN" ? counterpartyAccountId : accountId;
          const toId =
            t.record.direction === "IN" ? accountId : counterpartyAccountId;
          try {
            await ctx.api.activities.saveTransferPair({
              fromAccountId: fromId,
              toAccountId: toId,
              activityDate:
                t.record.datetime || `${t.record.date}T00:00:00.000Z`,
              sourceAmount: Math.abs(amt),
              destinationAmount: Math.abs(amt),
              sourceCurrency:
                (t.record.direction === "IN" ? counter?.currency : target?.currency) ??
                t.record.currency,
              destinationCurrency:
                (t.record.direction === "IN" ? target?.currency : counter?.currency) ??
                t.record.currency,
              transferMode: "cash",
              notes:
                `${t.record.description}${t.record.transactionId ? ` [TR:${t.record.transactionId}]` : ""}`.trim() ||
                undefined,
            });
            created++;
          } catch (e) {
            tErrors.push(
              `Line ${t.record.lineNumber}: ${e instanceof Error ? e.message : String(e)}`,
            );
          }
        }
      }
      setTransfersCreated(created);
      setTransferErrors(tErrors);

      try {
        await ctx.api.portfolio.update();
      } catch {
        // non-fatal
      }
      try {
        await ctx.api.query.invalidateQueries(["activities"]);
        await ctx.api.query.invalidateQueries(["portfolio"]);
      } catch {
        // non-fatal
      }
      ctx.api.toast.success(
        (importedSummary ? `Imported ${importedSummary} transactions` : "No securities selected") +
          (created > 0 ? ` · ${created} transfer pair${created === 1 ? "" : "s"} created` : "") +
          ".",
      );
      setStep("done");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(`Import failed: ${msg}`);
      ctx.api.toast.error("Trade Republic import failed.");
    } finally {
      setImporting(false);
    }
  }

  return (
    <div className="p-6 max-w-6xl mx-auto flex flex-col gap-4">
      <div>
        <h1 className="text-2xl font-semibold">Trade Republic importer</h1>
        <p className="text-muted-foreground text-sm">
          Import your Trade Republic CSV export. Standard securities use
          Wealthfolio market data; unresolved securities are imported manually.
          Duplicates are disabled automatically.
        </p>
      </div>

      <ol className="flex gap-2 text-xs">
        {(["account", "file", "resolution", "review", "done"] as Step[]).map(
          (s, i) => (
            <li key={s}>
              <Badge variant={step === s ? "default" : "secondary"}>
                {i + 1}. {s}
              </Badge>
            </li>
          ),
        )}
      </ol>

      {error && (
        <Card>
          <CardContent className="p-4 text-sm text-red-600">{error}</CardContent>
        </Card>
      )}

      {/* Step 1 — account picker */}
      <Card>
        <CardContent className="p-4 flex flex-col gap-3">
          <h2 className="font-medium">1 · Target account</h2>
          {accountsQuery.isLoading && <p className="text-sm">Loading accounts…</p>}
          {accountsQuery.isError && (
            <p className="text-sm text-red-600">Could not load accounts.</p>
          )}
          <div className="flex gap-2 items-center flex-wrap">
            <select
              className="border rounded px-2 py-2 text-sm bg-background"
              value={accountId}
              onChange={(e) => void pickAccount(e.target.value)}
            >
              <option value="">— choose account —</option>
              {accounts.map((a: Account) => (
                <option key={a.id} value={a.id}>
                  {a.name} · {a.currency} · {a.trackingMode}
                </option>
              ))}
            </select>
            {account && (
              <Badge variant="secondary">
                {account.name} · {account.currency}
              </Badge>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Step 2 — file */}
      <Card>
        <CardContent className="p-4 flex flex-col gap-3">
          <h2 className="font-medium">2 · Trade Republic CSV</h2>
          <Input
            type="file"
            accept=".csv,text/csv"
            disabled={!accountId}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void onFile(f);
            }}
          />
          {parseNote && <p className="text-xs text-muted-foreground">{parseNote}</p>}
        </CardContent>
      </Card>

      {/* Cash transfers → counterparty account + review */}
      {transfers.length > 0 && step !== "done" && (
        <Card>
          <CardContent className="p-4 flex flex-col gap-3">
            <h2 className="font-medium">
              Cash transfers · {transfers.filter((t) => t.selected && !t.duplicateOf).length}/
              {transfers.length} will be inserted as pairs
            </h2>
            <div className="flex gap-2 items-center flex-wrap text-sm">
              <span>Counterparty account (your bank / depository):</span>
              <select
                className="border rounded px-2 py-2 text-sm bg-background"
                value={counterpartyAccountId}
                onChange={(e) => void pickCounterparty(e.target.value)}
              >
                <option value="">— choose account —</option>
                {accounts
                  .filter((a: Account) => a.id !== accountId)
                  .map((a: Account) => (
                    <option key={a.id} value={a.id}>
                      {a.name} · {a.currency}
                    </option>
                  ))}
              </select>
            </div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Insert</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead>Direction</TableHead>
                  <TableHead>From → To</TableHead>
                  <TableHead>Amount</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {transfers.map((t) => {
                  const targetName =
                    accounts.find((a) => a.id === accountId)?.name ?? "target";
                  const counterName =
                    accounts.find((a) => a.id === counterpartyAccountId)?.name ??
                    "counterparty";
                  const route =
                    t.record.direction === "IN"
                      ? `${counterName} → ${targetName}`
                      : `${targetName} → ${counterName}`;
                  return (
                    <TableRow
                      key={t.record.lineNumber}
                      className={t.duplicateOf ? "opacity-60" : ""}
                    >
                      <TableCell>
                        <Checkbox
                          checked={t.selected && !t.duplicateOf}
                          disabled={!!t.duplicateOf}
                          onCheckedChange={(v) =>
                            setTransfers((prev) =>
                              prev.map((x) =>
                                x.record.lineNumber === t.record.lineNumber
                                  ? { ...x, selected: v === true }
                                  : x,
                              ),
                            )
                          }
                        />
                      </TableCell>
                      <TableCell className="text-xs">
                        {(t.record.datetime || t.record.date).slice(0, 10)}
                      </TableCell>
                      <TableCell>
                        <Badge variant={t.record.direction === "IN" ? "default" : "secondary"}>
                          {t.record.direction === "IN" ? "DEPOSIT" : "WITHDRAW"}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-xs">{route}</TableCell>
                      <TableCell className="text-xs">
                        {t.record.amount !== null ? Math.abs(t.record.amount) : "—"}{" "}
                        {t.record.currency}
                      </TableCell>
                      <TableCell>
                        {t.duplicateOf ? (
                          <Badge variant="destructive">DUPLICATE</Badge>
                        ) : (
                          <Badge variant="secondary">OK</Badge>
                        )}
                        {t.duplicateOf && (
                          <div className="text-xs text-muted-foreground mt-1">
                            {t.duplicateOf}
                          </div>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
            <div>
              <Button
                disabled={importing || !counterpartyAccountId}
                onClick={() => void onImport()}
              >
                {importing ? "Importing…" : "Import with transfers"}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Step 3 — standard market resolution */}
      {parsed && (
        <Card>
          <CardContent className="p-4 flex flex-col gap-3">
            <h2 className="font-medium">
              3 · Standard market lookup {resolving && "(checking…)"}
            </h2>
            <p className="text-xs text-muted-foreground">
              Wealthfolio checks standard providers for ordinary securities.
              Derivatives and ISINs without a standard quote stay manual; this
              importer does not search or assign custom providers for them.
            </p>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>ISIN</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead>Market</TableHead>
                  <TableHead>Source</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {distinctIsins.map(([isin, name]) => {
                  const r = resolutions[isin];
                  return (
                    <TableRow key={isin}>
                      <TableCell className="font-mono text-xs">{isin}</TableCell>
                      <TableCell className="text-xs">{name}</TableCell>
                      <TableCell className="text-xs">
                        {r?.label ?? "…"}
                      </TableCell>
                      <TableCell>
                        {r && (
                          <Badge
                            variant={r.source === "STANDARD" ? "secondary" : "outline"}
                          >
                            {r.source}
                          </Badge>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
            <div>
              <Button
                disabled={resolving || checking || distinctIsins.length === 0}
                onClick={() => void onCheck()}
              >
                {checking ? "Checking duplicates…" : "4 · Check duplicates"}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Step 4 — review */}
      {rows.length > 0 && step !== "done" && (
        <Card>
          <CardContent className="p-4 flex flex-col gap-3">
            <h2 className="font-medium">
              4 · Review — {counts.selected}/{counts.total} will be inserted ·{" "}
              {counts.dups} duplicates · {counts.invalid} invalid
            </h2>
            {rows.some(
              (r) =>
                isTradeRepublicDerivative(r.mapped.record) &&
                r.resolution.instrumentType === "EQUITY",
            ) && (
              <p className="text-xs text-amber-700">
                Trade Republic warrants and leveraged certificates are imported
                with 1× pricing. Wealthfolio’s OPTION type defaults to 100×, and
                the addon API cannot override that multiplier.
              </p>
            )}
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Insert</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead>Side</TableHead>
                  <TableHead>Name / ISIN</TableHead>
                  <TableHead>Qty</TableHead>
                  <TableHead>Price</TableHead>
                  <TableHead>Amount</TableHead>
                  <TableHead>Market</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => {
                  const dup = isDuplicate(r);
                  const invalid =
                    r.checkError !== null ||
                    (r.checked != null && r.checked.isValid === false);
                  const disabled = (dup || invalid) && !r.forced;
                  return (
                    <TableRow key={r.key} className={dup ? "opacity-60" : ""}>
                      <TableCell>
                        <Checkbox
                          checked={r.selected}
                          disabled={disabled && !r.selected}
                          onCheckedChange={(v) => toggleRow(r.key, v === true)}
                        />
                      </TableCell>
                      <TableCell className="text-xs">
                        {String(r.mapped.draft.date).slice(0, 10)}
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant={
                            r.mapped.draft.activityType === "BUY"
                              ? "default"
                              : "secondary"
                          }
                        >
                          {r.mapped.draft.activityType}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-xs">
                        {r.mapped.record.name}
                        <br />
                        <span className="font-mono">{r.mapped.draft.isin}</span>
                        <br />
                        <Badge variant="outline">
                          {isTradeRepublicDerivative(r.mapped.record) &&
                          r.resolution.instrumentType === "EQUITY"
                            ? "CERTIFICATE · 1×"
                            : r.resolution.instrumentType}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-xs">
                        {fmt(r.mapped.draft.quantity)}
                      </TableCell>
                      <TableCell className="text-xs">
                        {fmt(r.mapped.draft.unitPrice)}
                      </TableCell>
                      <TableCell className="text-xs">
                        {fmt(r.mapped.draft.amount)}
                      </TableCell>
                      <TableCell className="text-xs">{r.resolution.label}</TableCell>
                      <TableCell>
                        <div className="flex gap-1 flex-wrap">
                          {dup ? (
                            <>
                              <Badge variant="destructive">DUPLICATE</Badge>
                              <button
                                className="text-xs underline"
                                onClick={() => toggleForce(r.key)}
                              >
                                {r.forced ? "unforce" : "force"}
                              </button>
                            </>
                          ) : invalid ? (
                            <Badge variant="destructive">INVALID</Badge>
                          ) : (
                            <Badge variant="secondary">OK</Badge>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
            <div>
              <Button
                disabled={importing || counts.selected === 0}
                onClick={() => void onImport()}
              >
              {importing ? "Importing…" : `Import ${counts.selected} transactions`}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Step 5 — done */}
      {step === "done" && (result || transfersCreated > 0 || transferErrors.length > 0) && (
        <Card>
          <CardContent className="p-4 flex flex-col gap-3 text-sm">
            <h2 className="font-medium">5 · Import finished</h2>
            {result && (
              <p>
                Total {result.summary.total} · imported {result.summary.imported} ·
                skipped {result.summary.skipped} · duplicates{" "}
                {result.summary.duplicates} · assets created{" "}
                {result.summary.assetsCreated}
              </p>
            )}
            {(transfersCreated > 0 || transferErrors.length > 0) && (
              <p>
                Transfer pairs created: {transfersCreated}
                {transferErrors.length > 0 && ` · errors: ${transferErrors.length}`}
              </p>
            )}
            {transferErrors.map((e, i) => (
              <p key={i} className="text-xs text-red-600">{e}</p>
            ))}
            <div>
              <Button
                variant="secondary"
                onClick={() => {
                  setRows([]);
                  setParsed(null);
                  setResult(null);
                  setTransfers([]);
                  setTransfersCreated(0);
                  setTransferErrors([]);
                  setStep("file");
                }}
              >
                Import another file
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
