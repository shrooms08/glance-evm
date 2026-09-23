/**
 * Display formatting. Money and quantities come from @glance/core, the same code the API formats with: bigints in each
 * token's real decimals, never floating point.
 */
export { bpsToPercent, formatDuration, formatPercent, formatQuantity, formatUsd, parseDecimal, toDecimalString } from "@glance/core/format";

import { formatDuration } from "@glance/core/format";

/** "0x1234…abcd" */
export function shortAddress(a: string): string {
  return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

/**
 * An age in hours, as the prices page states it: "0.4 h", "3.1 h", "52 h". Tenths below 10 hours, whole hours above.
 * Integer maths on seconds (tenths of an hour are 360s), rounded to nearest.
 */
export function formatAgeHours(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const tenths = Math.floor((s + 180) / 360);
  if (tenths >= 100) return `${Math.floor((s + 1800) / 3600)} h`;
  return `${Math.floor(tenths / 10)}.${tenths % 10} h`;
}

/** Time until something, promising no earlier than it will be: "in 23 hours", "now". */
export function formatIn(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return "";
  if (seconds <= 0) return "now";
  return `in ${formatDuration(seconds, "up")}`;
}

/** Time since something: "12 minutes ago". */
export function formatAgo(seconds: number): string {
  if (seconds < 60) return "just now";
  return `${formatDuration(seconds)} ago`;
}

/** A unix time as a short local date and time, e.g. "Sep 23, 15:25". */
export function formatWhen(unix: number, locale?: string): string {
  return new Date(unix * 1000).toLocaleString(locale, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
}

/** A unix time's calendar day, for grouping: "Today", "Yesterday", or "Sep 21". */
export function dayLabel(unix: number, now: number, locale?: string): string {
  const d = new Date(unix * 1000);
  const n = new Date(now * 1000);
  const start = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((start(n) - start(d)) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return d.toLocaleDateString(locale, { month: "short", day: "numeric", year: d.getFullYear() === n.getFullYear() ? undefined : "numeric" });
}
