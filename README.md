# monero-quote-kit

Provider-agnostic **crypto swap quote aggregation** for TypeScript: ask every
provider at once, never let one of them break the page, compare the payouts
exactly, and show the user which quotes are missing and why.

Extracted from a production swap desk (31 guides, 28–32 non-custodial providers,
1,183 verification assertions) and reduced to the part that is worth sharing.

```
0.05 BTC → XMR
  ChangeNOW fixed      1.23456789   kyc=unknown   10-30 min
      · net 1.23456789 after fee 0
      · fixed rate
      · ranked on fixed-rate tie
  Trocador             1.22910000   kyc=A         10-60 min
      · net 1.22910000 after fee 0
      · best of 31 providers
x SimpleSwap                 —      kyc=unknown
      · unavailable: HTTP 503
```

Zero dependencies. Node 22.6+ (native TypeScript stripping), or any bundler.

## The four rules

Everything here exists to keep these true. They are cheap to write and expensive
to lose.

1. **One provider cannot fail the request.** A 500, a timeout, or an HTML error
   page where JSON belongs becomes one unavailable row. `collectQuotes` never
   rejects — the "all providers are down" case is a value, not an exception.
2. **Every provider gets its own deadline.** `fetch` has no default timeout; one
   slow provider otherwise sets the latency for the whole desk.
3. **Payouts are compared as decimals, not floats.** Amounts are scaled to
   `bigint` at 18 decimals. `0.1 + 0.2 !== 0.3` is not a curiosity when the
   amounts are 0.00012345 XMR.
4. **Failures are data.** The result carries `failures` next to `quotes`, so a
   caller cannot accidentally pretend it asked everybody when it did not.

## Use it

```ts
import { collectQuotes } from "./src/aggregate";
import { changeNowAdapter, changeNowFixedAdapter } from "./src/providers/changenow";
import { trocadorAdapter } from "./src/providers/trocador";

const result = await collectQuotes(
  [
    trocadorAdapter({ apiKey: process.env.TROCADOR_API_KEY! }),
    changeNowAdapter({ apiKey: process.env.CHANGENOW_API_KEY! }),
    changeNowFixedAdapter({ apiKey: process.env.CHANGENOW_API_KEY! }),
  ],
  { from: "btc", to: "xmr" },
  "0.05",
  { timeoutMs: 2500, rank: { maxKycTier: "B", preferFixed: true } },
);

for (const q of result.quotes) {
  console.log(q.providerName, q.netAmount, q.kycTier, q.reasons);
}
```

A runnable version is in `examples/desk.ts`:

```bash
TROCADOR_API_KEY=… CHANGENOW_API_KEY=… node --experimental-strip-types examples/desk.ts btc xmr 0.05
```

## Ranking, and why it is not "highest number wins"

`rankQuotes` sorts by **net payout** (payout minus the provider's withdrawal
fee) and then applies three tie-breakers that users actually care about:

| Rule | Why it exists |
| --- | --- |
| Fixed rate wins inside a tolerance (default 0.5%) | A locked number is worth a few basis points when the trade is large; it is not worth 4%. |
| Less KYC wins an exact tie | The user chose a privacy level. Ranking must not quietly override it. |
| `maxKycTier` blocks stricter providers outright | A quote that requires ID is not a cheaper option for someone who said no ID. |
| Provider id breaks remaining ties | Identical input must never reorder between requests; support tickets depend on it. |

Every ranked quote carries `reasons` — the arithmetic that put it there. That is
what an operator reads when someone asks "why did you show me this one".

Unavailable and expired quotes are returned at the end, **not filtered out**.
"We could not ask" and "we did not ask" look identical to a user and are very
different to whoever runs the site.

## Provider notes

**ChangeNOW** — floating and fixed-rate quotes for the same pair, both exposed.
The fixed quote returns a `rateId`; you must pass it back when creating the
exchange. `kycTier` is `unknown`, never `none`: ChangeNOW screens flagged trades
rather than requiring ID up front, and claiming otherwise would be a promise
they do not make. Key: `CHANGENOW_API_KEY`.

**Trocador** — one request returns an aggregator's whole provider table. This
adapter reports `quoteCount` and the winning provider's name, so the UI can say
"best of 31" instead of "best". Two traps handled: `quotes` arrives wrapped in
some API versions and bare in others (reading one shape collapses the table to a
single `unknown` row), and a missing key must produce an unavailable row rather
than an exception.

> The Trocador commercial key is **not self-serve**: register at
> `trocador.app/register/affiliate`, then email `commercial@trocador.app` to have
> it enabled. Until then this adapter reports `not configured`. Their affiliate
> programme also excludes EU traffic, so if you build a monetised desk, do not
> count EU visitors in the business case.

## Test it

```bash
npm install
npm test        # 26 tests, no network: every adapter runs against a mock fetch
npm run typecheck
```

The tests cover the parts that break in production: partial provider failure,
a provider that never answers (the deadline is asserted, not just reported),
both Trocador response shapes, non-JSON 200 bodies, fixed-rate `rateId`
preservation, and stable ordering across identical runs.

## What this is not

- Not a swap executor. It quotes. Creating the exchange, its deposit address and
  its status polling is your code and your API keys.
- Not a price oracle. Every number comes from a provider at request time.
- Not financial advice, and not a promise of savings. Rates move; quotes expire.

## Licence

MIT — see `LICENSE`. Copy it into your project, no attribution needed.

## The full site

This package is the quote layer of a complete Monero swap site (React 19, Vite 6,
Cloudflare Pages Functions, admin console, 31 guides as typed data, 13
verification suites). The full source is sold as a one-production licence:

**https://whop.com/biz_2c8zPoJWO1x9XY/monero-swap-site-source?utm_source=github-readme**

Live demo of the same code: **https://xmr.monster**
