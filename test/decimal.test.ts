import { test } from "node:test";
import assert from "node:assert/strict";

import { cmpDecimal, fromScaled, subDecimal, toScaled } from "../src/decimal.ts";

test("parses and scales plain decimals", () => {
  assert.equal(toScaled("1"), 1_000_000_000_000_000_000n);
  assert.equal(toScaled("0.5"), 500_000_000_000_000_000n);
  assert.equal(toScaled("0.00012345"), 123_450_000_000_000n);
  assert.equal(toScaled("1234.5"), 1_234_500_000_000_000_000_000n);
});

test("compares the values a float gets wrong", () => {
  // 0.1 + 0.2 !== 0.3 as floats; the payouts below are 17 digits deep.
  assert.equal(cmpDecimal("0.30000000000000001", "0.3"), 1);
  assert.equal(cmpDecimal("0.000000000000000001", "0.000000000000000002"), -1);
  assert.equal(cmpDecimal("2", "2.000000000000000000"), 0);
});

test("null sorts last, both ways round", () => {
  assert.equal(cmpDecimal(null, "1"), 1);
  assert.equal(cmpDecimal("1", null), -1);
  assert.equal(cmpDecimal(null, null), 0);
});

test("subtracts exactly", () => {
  assert.equal(subDecimal("1.00000001", "0.00000002"), "0.99999999");
  assert.equal(subDecimal("0.5", "0.00000001"), "0.49999999");
  // A missing fee is zero, not an error: providers often omit it.
  assert.equal(subDecimal("0.5", null), "0.5");
  assert.equal(subDecimal(null, "0.5"), null);
});

test("handles exponent notation some providers send", () => {
  assert.equal(toScaled("1e-8"), 10_000_000_000n);
  assert.equal(fromScaled(toScaled("1e-8")!), "0.00000001");
});

test("rejects junk instead of guessing", () => {
  for (const junk of ["", "  ", "abc", null, undefined, "NaN"]) {
    assert.equal(toScaled(junk as string), null);
  }
});

test("round-trips without trailing zeros", () => {
  assert.equal(fromScaled(toScaled("1.2300")!), "1.23");
  assert.equal(fromScaled(toScaled("0")!), "0");
  assert.equal(fromScaled(-5_000_000_000_000_000_000n), "-5");
});
