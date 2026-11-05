/**
 * Ranking: which quote a user should actually take.
 *
 * The naive answer is "the one with the highest payout", and it is wrong often
 * enough to matter:
 *
 *   - a fixed-rate quote at a lower payout beats a floating one when the trade
 *     is large, because the floating number can move before the deposit lands;
 *   - a quote that expires in 40 seconds is not a quote;
 *   - a payout that includes a withdrawal fee is not comparable with one that
 *     does not, so net is computed first;
 *   - KYC tier is the user's priority, not ours: someone who chose "no KYC" must
 *     not be shown an ID-required provider at the top because it pays 0.3% more.
 *
 * So each quote gets a score, and the score is explainable: `reasons` carries the
 * arithmetic that produced it, which is what a support ticket needs.
 */

import { cmpDecimal, subDecimal, toScaled } from "./decimal.ts";
import { KYC_TIERS, type KycTier, type ProviderQuote } from "./types.ts";

export interface RankOptions {
  /** Highest KYC tier the user will accept. Quotes above it are ranked last. */
  maxKycTier?: KycTier;
  /** Prefer fixed-rate quotes when payouts are close (within 0.5% by default). */
  preferFixed?: boolean;
  /** How close two payouts must be before `preferFixed` decides. Percent. */
  fixedTolerancePct?: number;
  /** Injected clock, so expiry is testable. */
  now?: Date;
}

export interface RankedQuote extends ProviderQuote {
  /** Net payout: toAmount minus the withdrawal fee, as a decimal string. */
  netAmount: string | null;
  score: number;
  reasons: string[];
  /** True when the quote is past validUntil at `now`. */
  expired: boolean;
  /** True when the quote's KYC tier is stricter than the caller allows. */
  kycBlocked: boolean;
}

const TIER_ORDER: KycTier[] = [...KYC_TIERS];

function tierRank(tier: KycTier): number {
  const i = TIER_ORDER.indexOf(tier);
  return i === -1 ? TIER_ORDER.length : i;
}

function isExpired(validUntil: string | null, now: Date): boolean {
  if (!validUntil) return false;
  const t = Date.parse(validUntil);
  if (Number.isNaN(t)) return false;
  return t <= now.getTime();
}

/**
 * Percent difference of `a` relative to `b`, as a float — used only for the
 * fixed-rate tolerance, never for the payout ordering itself.
 */
function relativePct(a: string | null, b: string | null): number {
  const x = toScaled(a);
  const y = toScaled(b);
  if (x === null || y === null || y === 0n) return 0;
  const diff = Number(x - y) / Number(y);
  return Math.abs(diff) * 100;
}

/**
 * Rank quotes. Available, unexpired, KYC-acceptable quotes come first, ordered
 * by net payout; everything else follows in a stable, explainable order.
 */
export function rankQuotes(quotes: ProviderQuote[], options: RankOptions = {}): RankedQuote[] {
  const now = options.now ?? new Date();
  const preferFixed = options.preferFixed ?? true;
  const tolerance = options.fixedTolerancePct ?? 0.5;
  const maxTier = options.maxKycTier;

  const scored: RankedQuote[] = quotes.map((q) => {
    const net = subDecimal(q.toAmount, q.withdrawalFee);
    const expired = isExpired(q.validUntil, now);
    const kycBlocked = maxTier ? tierRank(q.kycTier) > tierRank(maxTier) : false;
    const reasons: string[] = [];

    // The score is a sort key, not money: higher is better. Net payout is scaled
    // down so the boolean penalties below can dominate it.
    let score = 0;
    const netScaled = toScaled(net);
    if (netScaled !== null) score = Number(netScaled) / 1e18;

    if (!q.available) {
      score = Number.NEGATIVE_INFINITY;
      reasons.push("unavailable: " + (q.error ?? "no quote"));
      return { ...q, netAmount: net, score, reasons, expired, kycBlocked };
    }
    if (expired) {
      score = Number.NEGATIVE_INFINITY;
      reasons.push("expired at " + q.validUntil);
      return { ...q, netAmount: net, score, reasons, expired, kycBlocked };
    }
    if (!q.toAmount) {
      score = Number.NEGATIVE_INFINITY;
      reasons.push("no payout amount");
      return { ...q, netAmount: net, score, reasons, expired, kycBlocked };
    }

    reasons.push(`net ${net ?? "?"} after fee ${q.withdrawalFee ?? "0"}`);
    if (kycBlocked) {
      score = Number.NEGATIVE_INFINITY;
      reasons.push(`KYC ${q.kycTier} exceeds the allowed ${maxTier}`);
    } else if (q.kycTier === "none") {
      reasons.push("no KYC required");
    }
    if (q.fixed) reasons.push("fixed rate");

    return { ...q, netAmount: net, score, reasons, expired, kycBlocked };
  });

  const usable = scored.filter((q) => Number.isFinite(q.score));
  const dead = scored.filter((q) => !Number.isFinite(q.score));

  usable.sort((a, b) => {
    // 1. Fixed-rate preference, but only inside the tolerance band. A fixed quote
    //    paying 0.2% less is worth taking; one paying 4% less is not.
    if (preferFixed && a.fixed !== b.fixed) {
      const fixed = a.fixed ? a : b;
      const floating = a.fixed ? b : a;
      if (relativePct(fixed.netAmount, floating.netAmount) <= tolerance) {
        const tie = a.fixed ? -1 : 1;
        a.reasons.push("ranked on fixed-rate tie") ;
        if (cmpDecimal(a.netAmount, b.netAmount) !== 0) return tie;
      }
    }
    // 2. Net payout, exactly.
    const byNet = cmpDecimal(b.netAmount, a.netAmount);
    if (byNet !== 0) return byNet;
    // 3. Less KYC wins a tie.
    const byKyc = tierRank(a.kycTier) - tierRank(b.kycTier);
    if (byKyc !== 0) return byKyc;
    // 4. Stable: provider id, so repeated calls never reorder the same data.
    return a.providerId.localeCompare(b.providerId);
  });

  // Dead quotes keep their provider order rather than jumping around between
  // requests: an unavailable provider should look consistently unavailable.
  dead.sort((a, b) => a.providerId.localeCompare(b.providerId));

  return [...usable, ...dead];
}
