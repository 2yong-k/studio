export type Micros = bigint & { readonly __brand: 'Micros' };
export type Rounding = 'ceil' | 'floor';

type Ratio = { num: bigint; den: bigint };

const MICROS_PER_USD = 1_000_000n;
const MICROS_PER_MILLI_USD = 1_000n;
const MAX_UNIT_SIZE = 10n ** 9n;
const PLAIN_DECIMAL = /^(\d+)(?:\.(\d+))?$/;
const PLAIN_INTEGER = /^\d+$/;
const EXPONENT_FORM = /^(\d)(?:\.(\d+))?e([+-])(\d+)$/;

export function toMicros(n: bigint): Micros {
  if (n < 0n) throw new RangeError(`amount must not be negative: ${n}`);
  return n as Micros;
}

export function parseMicros(s: string): Micros {
  if (!PLAIN_INTEGER.test(s)) throw new RangeError(`not a micro-dollar integer string: ${JSON.stringify(s)}`);
  return toMicros(BigInt(s));
}

// Exponent forms and signs are rejected rather than expanded, so a value is only ever read one way.
function parseDecimal(s: string): Ratio {
  const match = PLAIN_DECIMAL.exec(s);
  if (match === null) throw new RangeError(`not a plain decimal: ${JSON.stringify(s)}`);
  const [, whole = '', frac = ''] = match;
  return { num: BigInt(whole + frac), den: 10n ** BigInt(frac.length) };
}

export function usdToMicros(usd: string, dir: Rounding): Micros {
  const { num, den } = parseDecimal(usd);
  return toMicros(mulDiv(num, MICROS_PER_USD, den, dir));
}

// A sub-micro price per unit (e.g. per token) would mostly vanish into ceil rounding, so the billing
// unit grows until the price is exact. It stops at 10^9, where the ceil error is under 1 μUSD per 10^9 units.
export function toUnitPrice(usd: string): { unitPriceMicros: Micros; unitSize: bigint } {
  const { num, den } = parseDecimal(usd);
  const microsTimesDen = num * MICROS_PER_USD;
  let unitSize = 1n;
  while (unitSize < MAX_UNIT_SIZE && (microsTimesDen * unitSize) % den !== 0n) unitSize *= 10n;
  return { unitPriceMicros: toMicros(ceilDiv(microsTimesDen * unitSize, den)), unitSize };
}

export function ceilDiv(a: bigint, b: bigint): bigint {
  return mulDiv(a, 1n, b, 'ceil');
}

// Operands are non-negative so bigint's truncating division is already floor.
export function mulDiv(a: bigint, b: bigint, d: bigint, dir: Rounding): bigint {
  if (a < 0n || b < 0n || d <= 0n) throw new RangeError(`mulDiv needs a, b >= 0 and d > 0: ${a}, ${b}, ${d}`);
  const product = a * b;
  const quotient = product / d;
  return dir === 'ceil' && quotient * d !== product ? quotient + 1n : quotient;
}

export function parseRate(s: string): Ratio {
  const rate = parseDecimal(s);
  if (rate.num > rate.den) throw new RangeError(`rate must be between 0 and 1: ${JSON.stringify(s)}`);
  return rate;
}

export function capOf(subtotal: Micros, rate: string): Micros {
  const { num, den } = parseRate(rate);
  return toMicros(mulDiv(subtotal, den + num, den, 'floor'));
}

// 10^n written out is "1" and n zeros, so the run of zeros comes without turning the exponent into a float.
const zeros = (n: bigint): string => (10n ** n).toString().slice(1);

// String() writes below 1e-6 and from 1e21 as "d.ddde-N"/"d.ddde+N"; moving the point by hand keeps the same
// digits. From 1e21 the mantissa has at most 16 fraction digits, so the point always lands past them.
function expandExponent(s: string): string {
  const m = EXPONENT_FORM.exec(s);
  if (m === null) return s;
  const [, lead = '', frac = '', sign = '', exp = ''] = m;
  if (sign === '-') return `0.${zeros(BigInt(exp) - 1n)}${lead}${frac}`;
  return `${lead}${frac}${zeros(BigInt(exp) - BigInt(frac.length))}`;
}

// String() yields the shortest decimal that round-trips to the same double, which is the value the
// provider meant; NaN, Infinity and negatives all fail the plain-decimal check.
export function priceNumberToDecimal(n: number): string {
  const s = expandExponent(String(n));
  if (!PLAIN_DECIMAL.test(s)) throw new RangeError(`price is not a plain non-negative decimal: ${String(n)}`);
  return s;
}

// Display only: half-up to $0.001, and any non-zero amount below that shows as "<$0.001" so it never reads as free.
export function formatUsd(x: Micros): string {
  if (x > 0n && x < MICROS_PER_MILLI_USD) return '<$0.001';
  const millis = (x + MICROS_PER_MILLI_USD / 2n) / MICROS_PER_MILLI_USD;
  return `$${millis / 1000n}.${(millis % 1000n).toString().padStart(3, '0')}`;
}
