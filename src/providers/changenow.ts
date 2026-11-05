/**
 * ChangeNOW adapter — the same trade, sold twice.
 *
 * ChangeNOW quotes a floating rate and a fixed rate for identical pairs. The
 * fixed one locks for a window and hands back a `rateId` you must pass at create
 * time. Both are offered here, because the choice between them (certainty versus
 * payout) belongs to the user; showing only the better-looking one is how a
 * comparison site stops being one.
 *
 * Docs: https://docs.changenow.io/ — v2 API, key in `x-changenow-api-key`.
 */

import { isBlank } from "../decimal.ts";
import type { ProviderAdapter, ProviderQuote, QuoteRequest } from "../types.ts";

export interface ChangeNowConfig {
  apiKey: string;
  /** Override for tests. */
  baseUrl?: string;
  /** Injected for tests; defaults to global fetch. */
  fetch?: typeof fetch;
}

interface ChangeNowEstimate {
  toAmount?: string;
  rateId?: string | null;
  validUntil?: string | null;
  minAmount?: string | number | null;
  maxAmount?: string | number | null;
  transactionSpeedForecast?: string | number | null;
  withdrawalFee?: string | number | null;
}

const num = (v: unknown): string | null => (isBlank(v) ? null : String(v));

function unavailable(id: string, name: string, fixed: boolean, error: string): ProviderQuote {
  return {
    providerId: id,
    providerName: name,
    fixed,
    toAmount: null,
    rate: null,
    minAmount: null,
    maxAmount: null,
    withdrawalFee: null,
    kycTier: "unknown",
    speed: null,
    validUntil: null,
    available: false,
    error,
  };
}

function toQuote(
  row: ChangeNowEstimate,
  id: string,
  name: string,
  fixed: boolean,
): ProviderQuote {
  const toAmount = num(row.toAmount);
  if (!toAmount) return unavailable(id, name, fixed, "no estimate returned");
  return {
    providerId: id,
    providerName: name,
    fixed,
    toAmount,
    // Left null on purpose: the provider's own rate field and its amounts can
    // disagree, and a desk that prints both invites an argument it cannot win.
    rate: null,
    minAmount: num(row.minAmount),
    maxAmount: num(row.maxAmount),
    withdrawalFee: num(row.withdrawalFee),
    // ChangeNOW runs KYC on trades it flags rather than up front. That is
    // "unknown", not "none" — "none" would be a promise they do not make.
    kycTier: "unknown",
    speed: num(row.transactionSpeedForecast),
    validUntil: num(row.validUntil),
    available: true,
    error: null,
    quoteId: fixed ? num(row.rateId) : null,
  };
}

function make(
  config: ChangeNowConfig,
  flow: "standard" | "fixed-rate",
  id: string,
  name: string,
): ProviderAdapter {
  const base = config.baseUrl ?? "https://api.changenow.io/v2";
  const doFetch = config.fetch ?? fetch;
  const fixed = flow === "fixed-rate";

  return {
    id,
    name,
    async quote(req: QuoteRequest): Promise<ProviderQuote> {
      const url = new URL(base + "/exchange/estimated-amount");
      url.searchParams.set("fromCurrency", req.pair.from.toLowerCase());
      url.searchParams.set("toCurrency", req.pair.to.toLowerCase());
      url.searchParams.set("flow", flow);
      url.searchParams.set(req.amountSide === "to" ? "toAmount" : "fromAmount", req.amount);
      if (req.pair.fromNetwork) url.searchParams.set("fromNetwork", req.pair.fromNetwork);
      if (req.pair.toNetwork) url.searchParams.set("toNetwork", req.pair.toNetwork);

      const res = await doFetch(url, {
        headers: { "x-changenow-api-key": config.apiKey },
        signal: req.signal,
      });

      // Rate limits and unknown pairs are facts about this provider right now,
      // not reasons to fail the whole desk.
      if (!res.ok) return unavailable(id, name, fixed, `HTTP ${res.status}`);

      let body: ChangeNowEstimate;
      try {
        body = (await res.json()) as ChangeNowEstimate;
      } catch {
        return unavailable(id, name, fixed, "response was not JSON");
      }
      return toQuote(body, id, name, fixed);
    },
  };
}

export function changeNowAdapter(config: ChangeNowConfig): ProviderAdapter {
  return make(config, "standard", "changenow", "ChangeNOW");
}

/** Fixed-rate variant, separate so a caller can offer one and not the other. */
export function changeNowFixedAdapter(config: ChangeNowConfig): ProviderAdapter {
  return make(config, "fixed-rate", "changenow_fixed", "ChangeNOW fixed");
}
