// Money is stored as exact decimal strings with a currency and computed in
// integer minor units. Floating point is never used for amounts.
const exponentCache = new Map();

export function isCurrencyCode(code) {
  if (typeof code !== 'string' || !/^[A-Z]{3}$/.test(code)) return false;
  try { new Intl.NumberFormat('en', { style: 'currency', currency: code }); return true; } catch { return false; }
}

export function currencyExponent(currency) {
  if (!exponentCache.has(currency)) {
    exponentCache.set(currency, new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits);
  }
  return exponentCache.get(currency);
}

export const AMOUNT_PATTERN = /^\d{1,11}(\.\d{1,3})?$/;

/** "1500.50" → 150050 (THB). Rejects more decimals than the currency allows. */
export function toMinor(amount, currency) {
  const text = String(amount ?? '0').trim();
  if (!AMOUNT_PATTERN.test(text)) throw new Error(`"${text}" is not a valid amount.`);
  const exponent = currencyExponent(currency);
  const [whole, fraction = ''] = text.split('.');
  if (fraction.replace(/0+$/, '').length > exponent) {
    throw new Error(`${currency} amounts allow at most ${exponent} decimal place(s).`);
  }
  return Number(whole) * 10 ** exponent + Number(fraction.padEnd(exponent, '0').slice(0, exponent) || 0);
}

export function fromMinor(minor, currency) {
  const exponent = currencyExponent(currency);
  const value = Math.round(minor);
  const sign = value < 0 ? '-' : '';
  const digits = String(Math.abs(value)).padStart(exponent + 1, '0');
  return exponent === 0 ? `${sign}${digits}` : `${sign}${digits.slice(0, -exponent)}.${digits.slice(-exponent)}`;
}

/** Multiply by a rational quantity, rounding half up to the minor unit. */
export function scaleMinor(minor, numerator, denominator = 1) {
  return Math.floor((minor * numerator * 2 + denominator) / (denominator * 2));
}

export function formatMoney(amount, currency) {
  return new Intl.NumberFormat('en', { style: 'currency', currency }).format(Number(amount));
}
