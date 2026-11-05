/**
 * The shapes everything else agrees on.
 *
 * One rule: a quote is a fact about a provider at a moment in time, and an
 * unavailable provider is still a fact. Nothing in this package silently drops
 * a provider, because "we could not ask" and "we did not ask" look identical to
 * a user and are very different to an operator.
 */

/** Money as a decimal string. Never a float: 0.00012345 is not representable. */
export type Decimal = string;

/** KYC tiers, least to most strict. `none` means the provider asks for nothing. */
export const KYC_TIERS = ["none", "A", "B", "C", "D", "unknown"] as const;
export type KycTier = (typeof KYC_TIERS)[number];

export interface Pair {
  from: string;
  to: string;
  /** Optional network disambiguation, e.g. USDT on TRC20. */
  fromNetwork?: string;
  toNetwork?: string;
}

export interface ProviderQuote {
  providerId: string;
  providerName: string;
  /** Fixed-rate quotes lock the number; floating ones move until the deposit lands. */
  fixed: boolean;
  /** What the user receives, in `pair.to` units. Null when the quote is unusable. */
  toAmount: Decimal | null;
  /** Provider-reported rate, for display. Null when the provider does not send one. */
  rate: Decimal | null;
  minAmount: Decimal | null;
  maxAmount: Decimal | null;
  /** Network fee taken out of the payout, so net = toAmount - withdrawalFee. */
  withdrawalFee: Decimal | null;
  kycTier: KycTier;
  /** Human speed label from the provider, e.g. "10-30 min". */
  speed: string | null;
  /** ISO timestamp; a quote past it must not be ranked first. */
  validUntil: string | null;
  available: boolean;
  /** Present when available === false: why this provider has no quote. */
  error: string | null;
  /** Provider-specific handle needed to execute this quote (rateId, trade id). */
  quoteId?: string | null;
  /** Aggregators only: how many candidates the provider considered. */
  quoteCount?: number | null;
  /** Aggregators only: which underlying exchange won the quote. */
  winner?: string | null;
}

/** What a provider adapter has to implement. Nothing else is assumed. */
export interface ProviderAdapter {
  id: string;
  name: string;
  /** Fetch one quote. Throwing is fine — the aggregator turns it into an error row. */
  quote(input: QuoteRequest): Promise<ProviderQuote>;
}

export interface QuoteRequest {
  pair: Pair;
  /** Amount to send, in `pair.from` units. */
  amount: Decimal;
  /** Set when the amount is what the user wants to *receive* instead. */
  amountSide?: "from" | "to";
  signal?: AbortSignal;
}

export interface QuoteFailure {
  providerId: string;
  providerName: string;
  error: string;
}
