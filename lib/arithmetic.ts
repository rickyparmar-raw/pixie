const MONEY = "(?:\\$?\\d{1,3}(?:,\\d{3})*|\\$?\\d+)(?:\\.\\d{1,2})?";
const PERCENT = "(?:\\d+(?:\\.\\d{1,4})?)";

function parseScaled(value: string, scale: number, label: string): bigint {
  const text = value.replace(/[$,]/g, "");
  const [whole, fraction = ""] = text.split(".");
  if (fraction.length > scale) throw new TypeError(`${label} has too many decimal places`);
  return BigInt(whole) * BigInt(10 ** scale) + BigInt((fraction + "0".repeat(scale)).slice(0, scale) || 0);
}

function roundDivide(numerator: bigint, denominator: bigint): bigint {
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  return quotient + (remainder * 2n >= denominator ? 1n : 0n);
}

function formatCents(cents: bigint): string {
  const whole = cents / 100n;
  const fraction = (cents % 100n).toString().padStart(2, "0");
  return `${whole}.${fraction}`;
}

function parseAmount(value: string, label = "amount"): bigint {
  const cents = parseScaled(value, 2, label);
  if (cents < 0n) throw new TypeError(`${label} must not be negative`);
  return cents;
}

function evaluate(expression: string): { mode: string; cents: bigint } {
  if (typeof expression !== "string" || expression.trim() === "") {
    throw new TypeError("expression must be a non-empty string");
  }

  const text = expression.trim();
  let match = text.match(new RegExp(`^(${PERCENT})%\\s+of\\s+(${MONEY})$`, "i"));
  if (match) {
    const percentage = parseScaled(match[1], 4, "percentage");
    const amount = parseAmount(match[2]);
    return {
      mode: "percentage-of",
      cents: roundDivide(amount * percentage, 1000000n),
    };
  }

  match = text.match(new RegExp(`^(${MONEY})\\s+including\\s+(${PERCENT})%$`, "i"));
  if (match) {
    const amount = parseAmount(match[1]);
    const percentage = parseScaled(match[2], 4, "percentage");
    return {
      mode: "including-percentage",
      cents: roundDivide(amount * (1000000n + percentage), 1000000n),
    };
  }

  match = text.match(new RegExp(`^(${MONEY})\\s*\\*\\s*(1(?:\\.\\d{1,4})?)$`));
  if (match) {
    const amount = parseAmount(match[1]);
    const multiplier = parseScaled(match[2], 4, "multiplier");
    return {
      mode: "including-percentage",
      cents: roundDivide(amount * multiplier, 10000n),
    };
  }

  throw new SyntaxError("unsupported arithmetic expression");
}

function calculate(expression: string): number {
  return Number(formatCents(evaluate(expression).cents));
}

function calculateMoney(expression: string): string {
  return formatCents(evaluate(expression).cents);
}

export = {
  calculate,
  calculateMoney,
  evaluate,
  formatCents,
};
