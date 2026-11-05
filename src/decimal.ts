/**
 * Exact decimal arithmetic for quote comparison.
 *
 * Providers send amounts as strings like "0.00012345" and "1234.5". Turning
 * those into floats and comparing them is how a ranking silently prefers the
 * wrong provider: 0.1 + 0.2 !== 0.3 at 17 decimal places, and XMR amounts live
 * at 12. So every comparison here scales to a bigint instead.
 *
 * This is not a currency library. It parses, subtracts and compares; that is all
 * a quote needs before the provider's own API takes over at execution time.
 */

import type { Decimal } from "./types.ts";

const DECIMALS = 18;

/** Parse a decimal string (or a number, defensively) to a scaled bigint. */
export function toScaled(value: Decimal | number | null | undefined): bigint | null {
  if (value === null || value === undefined) return null;
  const raw = String(value).trim();
  if (raw === "") return null;

  // Some providers send exponent notation ("1e-8") for small amounts.
  if (/e/i.test(raw)) {
    const n = Number(raw);
    if (!Number.isFinite(n)) return null;
    return toScaled(n.toFixed(DECIMALS));
  }

  const m = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(raw);
  if (!m) return null;
  const [, sign, whole, frac = ""] = m;
  if (whole === "" && frac === "") return null;

  const padded = (frac + "0".repeat(DECIMALS)).slice(0, DECIMALS);
  const scaled = BigInt((whole || "0") + padded);
  return sign === "-" ? -scaled : scaled;
}

/** Compare two decimals. Returns -1, 0 or 1; null values sort last. */
export function cmpDecimal(a: Decimal | null, b: Decimal | null): number {
  const x = toScaled(a);
  const y = toScaled(b);
  if (x === null && y === null) return 0;
  if (x === null) return 1;
  if (y === null) return -1;
  return x < y ? -1 : x > y ? 1 : 0;
}

/** a - b, as a decimal string. Null if either side is missing. */
export function subDecimal(a: Decimal | null, b: Decimal | null): Decimal | null {
  const x = toScaled(a);
  const y = toScaled(b);
  if (x === null) return null;
  if (y === null) return a;
  return fromScaled(x - y);
}

/** Render a scaled bigint back to a decimal string, trimming trailing zeros. */
export function fromScaled(scaled: bigint): Decimal {
  const negative = scaled < 0n;
  const abs = (negative ? -scaled : scaled).toString().padStart(DECIMALS + 1, "0");
  const whole = abs.slice(0, abs.length - DECIMALS);
  const frac = abs.slice(abs.length - DECIMALS).replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${frac ? "." + frac : ""}`;
}

/** True for the strings providers use to mean "nothing here". */
export function isBlank(value: unknown): boolean {
  return (
    value === null ||
    value === undefined ||
    (typeof value === "string" && value.trim() === "") ||
    (typeof value === "string" && /^(null|undefined|nan)$/i.test(value.trim()))
  );
}
