/** Client-side formatting. Money uses the token's real decimals; nothing money-related goes through floats. */

export function toRaw(value: string, decimals: number): bigint {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!m) throw new RangeError(`"${value}" is not an amount`);
  const fraction = (m[2] ?? "").slice(0, decimals).padEnd(decimals, "0");
  return BigInt(m[1]!) * 10n ** BigInt(decimals) + BigInt(fraction || "0");
}

export function fromRaw(raw: bigint | string, decimals: number): string {
  const v = BigInt(raw);
  const unit = 10n ** BigInt(decimals);
  const fraction = (v % unit).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${v / unit}${fraction ? `.${fraction}` : ""}`;
}

/** "$100", "$12.50", "$1,250". */
export function usd(raw: bigint | string, decimals: number): string {
  const v = BigInt(raw);
  const unit = 10n ** BigInt(decimals);
  const group = (n: bigint) => n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  if (v % unit === 0n) return `$${group(v / unit)}`;
  const cents = decimals >= 2 ? (v * 100n + unit / 2n) / unit : v * 10n ** BigInt(2 - decimals);
  if (cents === 0n) return "<$0.01";
  return `$${group(cents / 100n)}.${(cents % 100n).toString().padStart(2, "0")}`;
}

/** A price like "378.2226" as "$378.22". */
export function priceUsd(value: string): string {
  const n = Number(value);
  return Number.isFinite(n) ? `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : `$${value}`;
}

/** Price age in hours, as the design specifies ("22h old", "0.4h old"). */
export function ageHours(seconds: number): string {
  const h = seconds / 3600;
  if (h < 10) return `${h.toFixed(1)}h`;
  return `${Math.round(h)}h`;
}

/** "3 hours", "45 minutes", "2 days": rounded up, for promises about when something frees up. */
export function until(seconds: number): string {
  const s = Math.max(0, seconds);
  const plural = (n: number, u: string) => `${n} ${u}${n === 1 ? "" : "s"}`;
  if (s < 60) return "less than a minute";
  if (s < 3600) return plural(Math.ceil(s / 60), "minute");
  if (s < 48 * 3600) return plural(Math.ceil(s / 3600), "hour");
  return plural(Math.ceil(s / 86_400), "day");
}

/** Local clock time for a moment `seconds` from now, e.g. "4:12 PM". */
export function clockIn(seconds: number, now = Date.now()): string {
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(now + seconds * 1000));
}

export function shortHash(hash: string): string {
  return hash.length > 12 ? `${hash.slice(0, 6)}…${hash.slice(-4)}` : hash;
}
