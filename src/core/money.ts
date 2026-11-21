import { MerxError } from "./negotiate.ts";

/**
 * ISO 4217 minor-unit exponents for currencies Merx validates out of the box.
 * Merx stores every amount as an integer in minor units; this table only tells
 * adapters how many decimals a currency has. Extend it with `registerCurrency`
 * rather than converting through floating point.
 */
const EXPONENTS = new Map<string, number>([
  ["EUR", 2], ["USD", 2], ["GBP", 2], ["CHF", 2], ["CZK", 2], ["PLN", 2], ["HUF", 2],
  ["SEK", 2], ["NOK", 2], ["DKK", 2], ["RON", 2], ["BGN", 2], ["CAD", 2], ["AUD", 2],
  ["NZD", 2], ["SGD", 2], ["HKD", 2], ["MXN", 2], ["BRL", 2], ["INR", 2], ["CNY", 2],
  ["JPY", 0], ["KRW", 0], ["ISK", 0], ["CLP", 0], ["VND", 0],
  ["BHD", 3], ["KWD", 3], ["OMR", 3], ["JOD", 3], ["TND", 3],
]);

/** Largest amount Merx accepts: safely below Number.MAX_SAFE_INTEGER. */
export const MAX_MINOR_AMOUNT = 999_999_999_999;

export function registerCurrency(code: string, exponent: number): void {
  if (!/^[A-Z]{3}$/.test(code) || !Number.isInteger(exponent) || exponent < 0 || exponent > 4) throw new Error("Currency must be an ISO 4217 code with an exponent between 0 and 4");
  EXPONENTS.set(code, exponent);
}

export function currencyExponent(code: string): number {
  const exponent = EXPONENTS.get(code);
  if (exponent === undefined) throw new MerxError("invalid", `unsupported currency ${code}`);
  return exponent;
}

export function isSupportedCurrency(code: unknown): code is string {
  return typeof code === "string" && EXPONENTS.has(code);
}

/** Throws unless `amount` is a non-negative safe integer in minor units (or positive when `positive`). */
export function assertMinorAmount(amount: unknown, opts: { positive?: boolean; field?: string } = {}): asserts amount is number {
  const field = opts.field ?? "amount";
  if (typeof amount !== "number" || !Number.isSafeInteger(amount) || amount < 0 || amount > MAX_MINOR_AMOUNT) throw new MerxError("invalid", `${field} must be a non-negative integer in minor units`);
  if (opts.positive && amount === 0) throw new MerxError("invalid", `${field} must be greater than zero`);
}

/** Validates an amount/currency pair as it will be sent to a payment provider. */
export function assertMoney(amount: unknown, currency: unknown, opts: { positive?: boolean } = {}): void {
  if (!isSupportedCurrency(currency)) throw new MerxError("invalid", `unsupported currency ${String(currency)}`);
  assertMinorAmount(amount, opts);
}

/** Human-readable decimal string without floating-point arithmetic, e.g. 1290 EUR → "12.90". */
export function formatMinor(amount: number, currency: string): string {
  assertMinorAmount(amount);
  const exponent = currencyExponent(currency);
  if (exponent === 0) return String(amount);
  const digits = String(amount).padStart(exponent + 1, "0");
  return `${digits.slice(0, -exponent)}.${digits.slice(-exponent)}`;
}
