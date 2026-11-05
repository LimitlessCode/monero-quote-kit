/**
 * Trocador adapter — one request, a whole provider table.
 *
 * Trocador is an aggregator of aggregators: `/new_rate` returns every provider in
 * its table that can serve the pair, each with a payout and a KYC rating. The
 * useful thing is not the best number, it is the *shape* of the table — which is
 * why this adapter keeps the number of candidates and the winning provider's name
 * on the quote, so a desk can say "best of 31" instead of "best".
 *
 * Two traps this code handles:
 *   1. `quotes` arrives wrapped (`{ markup: false, quotes: [...] }`) in one API
 *      version and bare (`[...]`) in another. Reading only one shape silently
 *      collapses the table to a single "unknown" row.
 *   2. The key is not self-serve. A missing key must produce an unavailable row,
 *      not an exception — see the note in the README.
 *
 * Docs: https://trocador.app/en/docs/ — key in the `API-Key` header, and the
 * commercial key requires manual approval.
 */

import { isBlank } from "../decimal.ts";
import type { KycTier, ProviderAdapter, ProviderQuote, QuoteRequest } from "../types.ts";

export interface TrocadorConfig {
  apiKey: string;
  /** 0 shares Trocador's commission; >0 adds a visible markup the operator keeps. */
  markup?: "0" | "1" | "1.65" | "3";
  /** Only accept providers at or below this KYC rating. */
  minKycRating?: KycTier;
  baseUrl?: string;
  fetch?: typeof fetch;
}

interface TrocadorRow {
  provider?: string;
  amount_to?: string | number;
  amount_from?: string | number;
  rate?: string | number;
  minimum?: string | number | null;
  kycrating?: string;
  logourl?: string;
  trade_id?: string | null;
}

interface TrocadorResponse {
  amount_to?: string;
  quotes?: TrocadorRow[] | { quotes?: TrocadorRow[] };
}

const num = (v: unknown): string | null => (isBlank(v) ? null : String(v));

/** Map Trocador's rating letters onto the shared tier scale. */
export function kycFromRating(rating: unknown): KycTier {
  const r = String(rating ?? "").trim().toUpperCase();
  if (r === "A" || r === "B" || r === "C" || r === "D") return r as KycTier;
  if (r === "NONE" || r === "" || r === "0") return "none";
  return "unknown";
}

/** Accept both wrapped and bare `quotes`, and never return a non-array. */
function tableOf(body: TrocadorResponse): TrocadorRow[] {
  const t = body?.quotes;
  if (Array.isArray(t)) return t;
  if (t && Array.isArray(t.quotes)) return t.quotes;
  return [];
}

export function trocadorAdapter(config: TrocadorConfig): ProviderAdapter {
  const base = config.baseUrl ?? "https://api.trocador.app";
  const doFetch = config.fetch ?? fetch;

  return {
    id: "trocador",
    name: "Trocador",
    async quote(req: QuoteRequest): Promise<ProviderQuote> {
      const empty: ProviderQuote = {
        providerId: "trocador",
        providerName: "Trocador",
        fixed: false,
        toAmount: null,
        rate: null,
        minAmount: null,
        maxAmount: null,
        withdrawalFee: null,
        kycTier: "unknown",
        speed: null,
        validUntil: null,
        available: false,
        error: "not configured",
      };

      if (!config.apiKey) return empty;

      const url = new URL(base + "/api/v1/new_rate");
      url.searchParams.set("ticker_from", req.pair.from.toLowerCase());
      url.searchParams.set("ticker_to", req.pair.to.toLowerCase());
      if (req.pair.fromNetwork) url.searchParams.set("network_from", req.pair.fromNetwork.toUpperCase());
      if (req.pair.toNetwork) url.searchParams.set("network_to", req.pair.toNetwork.toUpperCase());
      url.searchParams.set(req.amountSide === "to" ? "amount_to" : "amount_from", req.amount);
      url.searchParams.set("markup", config.markup ?? "0");
      if (config.minKycRating) url.searchParams.set("min_kycrating", config.minKycRating);

      const res = await doFetch(url, {
        headers: { "API-Key": config.apiKey },
        signal: req.signal,
      });
      if (!res.ok) return { ...empty, error: `HTTP ${res.status}` };

      let body: TrocadorResponse;
      try {
        body = (await res.json()) as TrocadorResponse;
      } catch {
        return { ...empty, error: "response was not JSON" };
      }

      const table = tableOf(body);
      const best = num((body as TrocadorRow).amount_to);
      const winnerRow = table.length > 0 ? table[0] : null;
      if (!best) return { ...empty, error: "no rate returned" };

      return {
        ...empty,
        toAmount: best,
        minAmount: num(table[0]?.minimum ?? null),
        kycTier: kycFromRating((body as TrocadorRow).kycrating ?? winnerRow?.kycrating),
        available: true,
        error: null,
        // "best of 31" is more informative than "best", and it is a fact the
        // table actually contains.
        quoteCount: table.length || null,
        winner: winnerRow?.provider ? String(winnerRow.provider) : null,
      };
    },
  };
}
