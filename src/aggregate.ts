/**
 * Fan-out: ask every provider at once, never let one of them break the page.
 *
 * Three properties this file exists to guarantee, each of which was a real bug
 * somewhere before it was a design:
 *
 *   1. **Isolation.** A provider that 500s, hangs, or returns HTML where JSON
 *      belongs produces one error row, not a failed request.
 *   2. **A deadline.** Each provider gets its own AbortSignal timeout. `fetch`
 *      has no default timeout, and one slow provider otherwise sets the page's
 *      latency for everybody.
 *   3. **Honest output.** The result carries `failures` alongside `quotes`, so a
 *      caller can decide what to show but cannot accidentally pretend it asked
 *      everyone when it did not.
 */

import { rankQuotes, type RankOptions, type RankedQuote } from "./rank.ts";
import type { Pair, ProviderAdapter, ProviderQuote, QuoteFailure } from "./types.ts";

export interface AggregateOptions {
  /** Per-provider deadline in milliseconds. */
  timeoutMs?: number;
  /** Clock, passed through to ranking. */
  now?: Date;
  /** Ranking options (KYC ceiling, fixed-rate preference). */
  rank?: RankOptions;
}

export interface AggregateResult {
  pair: Pair;
  amount: string;
  /** Ranked best-first, unavailable and expired rows included at the end. */
  quotes: RankedQuote[];
  /** Providers that threw or timed out, with the reason. */
  failures: QuoteFailure[];
  /** Wall-clock time for the whole fan-out. */
  elapsedMs: number;
}

const DEFAULT_TIMEOUT_MS = 2500;

function reasonFor(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === "AbortError" || err.name === "TimeoutError") return "timeout";
    return err.message.slice(0, 200) || err.name;
  }
  return String(err).slice(0, 200) || "unknown error";
}

/**
 * Run every adapter with its own deadline and merge the results.
 *
 * Never rejects: a caller that gets a rejected promise here would have to handle
 * the "all providers are down" case at every call site, and none of them do.
 */
export async function collectQuotes(
  adapters: ProviderAdapter[],
  pair: Pair,
  amount: string,
  options: AggregateOptions = {},
): Promise<AggregateResult> {
  const started = Date.now();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = options.now ?? new Date();

  const results = await Promise.allSettled(
    adapters.map(async (adapter) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const quote = await adapter.quote({ pair, amount, signal: controller.signal });
        return quote;
      } finally {
        clearTimeout(timer);
      }
    }),
  );

  const quotes: ProviderQuote[] = [];
  const failures: QuoteFailure[] = [];

  results.forEach((result, i) => {
    const adapter = adapters[i];
    if (!adapter) return; // lengths match by construction; belt and braces
    if (result.status === "fulfilled") {
      quotes.push(result.value);
    } else {
      failures.push({
        providerId: adapter.id,
        providerName: adapter.name,
        error: reasonFor(result.reason),
      });
    }
  });

  return {
    pair,
    amount,
    quotes: rankQuotes(quotes, { now, ...(options.rank ?? {}) }),
    failures,
    elapsedMs: Date.now() - started,
  };
}

/**
 * A provider that is switched off. It returns an unavailable row rather than
 * throwing, because "we do not offer this" and "this provider is broken" are
 * different facts and the user is entitled to the difference.
 */
export function disabledAdapter(id: string, name: string, reason = "not configured"): ProviderAdapter {
  return {
    id,
    name,
    async quote(): Promise<ProviderQuote> {
      return {
        providerId: id,
        providerName: name,
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
        error: reason,
      };
    },
  };
}
