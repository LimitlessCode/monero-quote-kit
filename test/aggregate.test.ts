import { test } from "node:test";
import assert from "node:assert/strict";

import { collectQuotes, disabledAdapter } from "../src/aggregate.ts";
import { changeNowAdapter, changeNowFixedAdapter } from "../src/providers/changenow.ts";
import { trocadorAdapter, kycFromRating } from "../src/providers/trocador.ts";
import type { ProviderAdapter, ProviderQuote } from "../src/types.ts";

const PAIR = { from: "btc", to: "xmr" };

function ok(id: string, toAmount: string): ProviderAdapter {
  return {
    id,
    name: id,
    async quote(): Promise<ProviderQuote> {
      return {
        providerId: id,
        providerName: id,
        fixed: false,
        toAmount,
        rate: null,
        minAmount: null,
        maxAmount: null,
        withdrawalFee: null,
        kycTier: "unknown",
        speed: null,
        validUntil: null,
        available: true,
        error: null,
      };
    },
  };
}

const exploding: ProviderAdapter = {
  id: "exploding",
  name: "Exploding",
  async quote(): Promise<ProviderQuote> {
    throw new Error("connection reset");
  },
};

const hanging: ProviderAdapter = {
  id: "hanging",
  name: "Hanging",
  quote: (req) =>
    new Promise((_resolve, reject) => {
      req.signal?.addEventListener("abort", () => {
        const err = new Error("aborted");
        err.name = "AbortError";
        reject(err);
      });
    }),
};

test("one broken provider does not fail the fan-out", async () => {
  const result = await collectQuotes([ok("a", "1"), exploding], PAIR, "0.05");
  assert.equal(result.quotes.length, 1);
  assert.equal(result.quotes[0].providerId, "a");
  assert.deepEqual(result.failures.map((f) => f.providerId), ["exploding"]);
  assert.match(result.failures[0].error, /connection reset/);
});

test("a provider that never answers is cut off at the deadline", async () => {
  const started = Date.now();
  const result = await collectQuotes([ok("fast", "1"), hanging], PAIR, "0.05", { timeoutMs: 120 });
  const took = Date.now() - started;
  assert.equal(result.quotes[0].providerId, "fast");
  assert.equal(result.failures[0].providerId, "hanging");
  assert.equal(result.failures[0].error, "timeout");
  // The deadline is honoured, not merely reported.
  assert.ok(took < 1200, `fan-out took ${took}ms`);
});

test("results come back ranked, not in arrival order", async () => {
  const result = await collectQuotes([ok("a", "1"), ok("b", "2")], PAIR, "0.05");
  assert.deepEqual(result.quotes.map((q) => q.providerId), ["b", "a"]);
  assert.equal(typeof result.elapsedMs, "number");
});

test("a disabled provider is present and honest, never silently missing", async () => {
  const result = await collectQuotes([ok("a", "1"), disabledAdapter("x", "X", "no key")], PAIR, "0.05");
  const off = result.quotes.find((q) => q.providerId === "x");
  assert.equal(off?.available, false);
  assert.equal(off?.error, "no key");
});

/* ── provider adapters, with fetch injected ─────────────────────────────── */

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("ChangeNOW normalises a standard estimate", async () => {
  let seenUrl = "";
  const adapter = changeNowAdapter({
    apiKey: "test-key",
    fetch: (async (url: URL) => {
      seenUrl = String(url);
      return jsonResponse({
        toAmount: "1.23456789",
        minAmount: "0.001",
        maxAmount: "10",
        transactionSpeedForecast: "10-30",
      });
    }) as unknown as typeof fetch,
  });

  const quote = await adapter.quote({ pair: PAIR, amount: "0.05" });
  assert.equal(quote.available, true);
  assert.equal(quote.toAmount, "1.23456789");
  assert.equal(quote.speed, "10-30");
  assert.equal(quote.kycTier, "unknown"); // never "none" on a provider's behalf
  assert.match(seenUrl, /flow=standard/);
  assert.match(seenUrl, /fromAmount=0\.05/);
});

test("ChangeNOW fixed-rate keeps the rateId that execution needs", async () => {
  const adapter = changeNowFixedAdapter({
    apiKey: "k",
    fetch: (async () =>
      jsonResponse({ toAmount: "1.2", rateId: "abc123", validUntil: "2026-01-01T00:20:00Z" })) as unknown as typeof fetch,
  });
  const quote = await adapter.quote({ pair: PAIR, amount: "0.05" });
  assert.equal(quote.fixed, true);
  assert.equal(quote.quoteId, "abc123");
  assert.equal(quote.validUntil, "2026-01-01T00:20:00Z");
});

test("an HTML error page becomes an unavailable row, not a crash", async () => {
  const adapter = changeNowAdapter({
    apiKey: "k",
    fetch: (async () => new Response("<html>502</html>", { status: 502 })) as unknown as typeof fetch,
  });
  const quote = await adapter.quote({ pair: PAIR, amount: "0.05" });
  assert.equal(quote.available, false);
  assert.equal(quote.error, "HTTP 502");
});

test("non-JSON 200 bodies are handled too", async () => {
  const adapter = changeNowAdapter({
    apiKey: "k",
    fetch: (async () => new Response("not json", { status: 200 })) as unknown as typeof fetch,
  });
  const quote = await adapter.quote({ pair: PAIR, amount: "0.05" });
  assert.equal(quote.available, false);
  assert.match(quote.error ?? "", /not JSON/);
});

test("Trocador reads both quote-table shapes and reports best-of-N", async () => {
  const rows = [
    { provider: "Alpha", amount_to: "1.5", kycrating: "A", minimum: "0.001" },
    { provider: "Beta", amount_to: "1.4", kycrating: "B" },
  ];
  for (const quotes of [rows, { markup: false, quotes: rows }]) {
    const adapter = trocadorAdapter({
      apiKey: "k",
      fetch: (async () => jsonResponse({ amount_to: "1.5", kycrating: "A", quotes })) as unknown as typeof fetch,
    });
    const quote = await adapter.quote({ pair: PAIR, amount: "0.05" });
    assert.equal(quote.available, true, "both shapes must survive");
    assert.equal(quote.toAmount, "1.5");
    assert.equal(quote.quoteCount, 2);
    assert.equal(quote.winner, "Alpha");
    assert.equal(quote.kycTier, "A");
  }
});

test("Trocador with no key is unavailable rather than throwing", async () => {
  const adapter = trocadorAdapter({ apiKey: "" });
  const quote = await adapter.quote({ pair: PAIR, amount: "0.05" });
  assert.equal(quote.available, false);
  assert.equal(quote.error, "not configured");
});

test("KYC rating letters map onto the shared scale", () => {
  assert.equal(kycFromRating("A"), "A");
  assert.equal(kycFromRating("d"), "D");
  assert.equal(kycFromRating("NONE"), "none");
  assert.equal(kycFromRating(""), "none");
  assert.equal(kycFromRating("weird"), "unknown");
});
