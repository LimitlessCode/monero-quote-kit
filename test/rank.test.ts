import { test } from "node:test";
import assert from "node:assert/strict";

import { rankQuotes } from "../src/rank.ts";
import type { ProviderQuote } from "../src/types.ts";

/** Build a quote with sensible defaults, so each test states only what it cares about. */
function q(over: Partial<ProviderQuote> & { providerId: string }): ProviderQuote {
  return {
    providerName: over.providerId,
    fixed: false,
    toAmount: "1",
    rate: null,
    minAmount: null,
    maxAmount: null,
    withdrawalFee: null,
    kycTier: "unknown",
    speed: null,
    validUntil: null,
    available: true,
    error: null,
    ...over,
  };
}

test("highest net payout wins", () => {
  const ranked = rankQuotes([
    q({ providerId: "a", toAmount: "1.0" }),
    q({ providerId: "b", toAmount: "1.1" }),
    q({ providerId: "c", toAmount: "0.9" }),
  ]);
  assert.deepEqual(ranked.map((r) => r.providerId), ["b", "a", "c"]);
});

test("the withdrawal fee is subtracted before comparing", () => {
  // a pays more but also charges a fee; b's net is higher.
  const ranked = rankQuotes([
    q({ providerId: "a", toAmount: "1.05", withdrawalFee: "0.06" }),
    q({ providerId: "b", toAmount: "1.00", withdrawalFee: "0.00" }),
  ]);
  assert.equal(ranked[0].providerId, "b");
  assert.equal(ranked[0].netAmount, "1");
  assert.equal(ranked[1].netAmount, "0.99");
});

test("unavailable and expired quotes sink, and say why", () => {
  const now = new Date("2026-01-01T00:00:00Z");
  const ranked = rankQuotes(
    [
      q({ providerId: "dead", available: false, error: "HTTP 503", toAmount: "5" }),
      q({ providerId: "stale", toAmount: "4", validUntil: "2025-12-31T23:59:00Z" }),
      q({ providerId: "live", toAmount: "1" }),
    ],
    { now },
  );
  assert.deepEqual(ranked.map((r) => r.providerId), ["live", "dead", "stale"]);
  assert.equal(ranked[1].reasons.join(" ").includes("HTTP 503"), true);
  assert.equal(ranked[2].expired, true);
});

test("a fixed rate wins a tie inside the tolerance, and loses outside it", () => {
  const inside = rankQuotes([
    q({ providerId: "floating", toAmount: "1.000" }),
    q({ providerId: "fixed", toAmount: "0.997", fixed: true }), // 0.3% less
  ]);
  assert.equal(inside[0].providerId, "fixed");

  const outside = rankQuotes([
    q({ providerId: "floating", toAmount: "1.000" }),
    q({ providerId: "fixed", toAmount: "0.900", fixed: true }), // 10% less
  ]);
  assert.equal(outside[0].providerId, "floating");
});

test("the KYC ceiling is respected even when the blocked quote pays most", () => {
  const ranked = rankQuotes(
    [
      q({ providerId: "id-required", toAmount: "9", kycTier: "C" }),
      q({ providerId: "no-kyc", toAmount: "1", kycTier: "none" }),
    ],
    { maxKycTier: "A" },
  );
  assert.equal(ranked[0].providerId, "no-kyc");
  assert.equal(ranked[1].kycBlocked, true);
});

test("equal payouts break the tie on less KYC, then on id, stably", () => {
  const ranked = rankQuotes([
    q({ providerId: "z", toAmount: "1", kycTier: "A" }),
    q({ providerId: "a", toAmount: "1", kycTier: "A" }),
    q({ providerId: "m", toAmount: "1", kycTier: "none" }),
  ]);
  assert.deepEqual(ranked.map((r) => r.providerId), ["m", "a", "z"]);
});

test("ranking is stable across runs with identical input", () => {
  const input = [
    q({ providerId: "b", toAmount: "1.0" }),
    q({ providerId: "a", toAmount: "1.0" }),
    q({ providerId: "c", toAmount: "1.0" }),
  ];
  const once = rankQuotes(input).map((r) => r.providerId);
  const twice = rankQuotes(input).map((r) => r.providerId);
  assert.deepEqual(once, twice);
});

test("a quote with no payout is dead, not a zero", () => {
  const ranked = rankQuotes([
    q({ providerId: "empty", toAmount: null }),
    q({ providerId: "real", toAmount: "0.0001" }),
  ]);
  assert.equal(ranked[0].providerId, "real");
  assert.equal(ranked[1].score, Number.NEGATIVE_INFINITY);
});
