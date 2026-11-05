/**
 * A quote desk in 30 lines: every provider in parallel, table printed best-first.
 *
 *   TROCADOR_API_KEY=… CHANGENOW_API_KEY=… node --experimental-strip-types examples/desk.ts btc xmr 0.05
 *
 * Missing keys are fine — those providers show up as unavailable instead of
 * breaking the run. That is the whole point of the aggregator.
 */

import { collectQuotes } from "../src/aggregate.ts";
import { changeNowAdapter, changeNowFixedAdapter } from "../src/providers/changenow.ts";
import { trocadorAdapter } from "../src/providers/trocador.ts";
import type { ProviderAdapter } from "../src/types.ts";

const [from = "btc", to = "xmr", amount = "0.05"] = process.argv.slice(2);
const pair = { from, to };

const adapters: ProviderAdapter[] = [
  trocadorAdapter({ apiKey: process.env.TROCADOR_API_KEY ?? "" }),
  changeNowAdapter({ apiKey: process.env.CHANGENOW_API_KEY ?? "" }),
  changeNowFixedAdapter({ apiKey: process.env.CHANGENOW_API_KEY ?? "" }),
];

const result = await collectQuotes(adapters, pair, amount, {
  timeoutMs: 2500,
  // Never rank a provider the user did not agree to identify themselves to.
  rank: { maxKycTier: "B" },
});

console.log(`${amount} ${pair.from.toUpperCase()} → ${pair.to.toUpperCase()}`);
for (const q of result.quotes) {
  const payout = q.netAmount ?? "—";
  const flag = q.available ? " " : "x";
  console.log(
    `${flag} ${q.providerName.padEnd(16)} ${payout.padStart(14)}  kyc=${q.kycTier.padEnd(7)} ${q.speed ?? ""}`,
  );
  for (const reason of q.reasons) console.log(`    · ${reason}`);
}
for (const f of result.failures) {
  console.log(`x ${f.providerName}: ${f.error}`);
}
console.log(`\n${result.quotes.filter((q) => q.available).length} quotes in ${result.elapsedMs}ms`);
