const { test } = require("node:test");
const assert = require("node:assert/strict");
const arithmetic = require("./arithmetic");

test("calculates a percentage of an amount without floating-point drift", () => {
  assert.equal(arithmetic.calculateMoney("18% of 459"), "82.62");
  assert.equal(arithmetic.calculate("18% of 459"), 82.62);
  assert.equal(arithmetic.evaluate("18% of 459").mode, "percentage-of");
});

test("calculates an amount including a percentage", () => {
  assert.equal(arithmetic.calculateMoney("459 * 1.18"), "541.62");
  assert.equal(arithmetic.calculateMoney("459 including 18%"), "541.62");
  assert.equal(arithmetic.evaluate("459 * 1.18").mode, "including-percentage");
});

test("uses integer cents and rounds a fractional cent deterministically", () => {
  assert.equal(arithmetic.calculateMoney("33.33% of 10.00"), "3.33");
  assert.equal(arithmetic.calculateMoney("10.00 * 1.3333"), "13.33");
});

test("accepts ordinary money formatting but no arbitrary syntax", () => {
  assert.equal(arithmetic.calculateMoney("7.5% of $1,200.00"), "90.00");
  for (const expression of [
    "459 + 82.62",
    "Math.max(1, 2)",
    "process.exit()",
    "18 % of 459",
    "459 * 1.18 + 2",
    "",
  ]) {
    assert.throws(() => arithmetic.calculate(expression), /unsupported|expression/);
  }
});

test("rejects malformed and negative inputs", () => {
  assert.throws(() => arithmetic.calculate("101% of -10"), SyntaxError);
  assert.throws(() => arithmetic.calculate("18% of 459.999"), /unsupported|decimal/);
  assert.throws(() => arithmetic.calculate("459 * 2"), SyntaxError);
});
