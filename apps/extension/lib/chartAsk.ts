/**
 * TradingView's full chart page (tradingview.com/chart/...), when its range can't be read: Glance asks once, with the
 * ranges as buttons (1D, 5D, 1M, 3M, 6M, 1Y; or said: "five days", "one month"), and remembers the answer for this tab,
 * this chart and this symbol until the URL, the symbol or the page's range changes. Never asked again on the next
 * question. Pure: the content script keeps one ChartAnswers per tab.
 */
import type { ChartRange } from "@glance/core/chart";

/** The ranges offered, in the order TradingView's range bar shows them. */
export const RANGE_CHOICES = ["1D", "1W", "1M", "3M", "6M", "1Y"] as const satisfies readonly ChartRange[];

/** Each choice's button, as TradingView labels it (its "5 days" is 5D). */
export const RANGE_BUTTON: Record<(typeof RANGE_CHOICES)[number], string> = { "1D": "1D", "1W": "5D", "1M": "1M", "3M": "3M", "6M": "6M", "1Y": "1Y" };

/** The question, with the stock when it's known. */
export const rangeQuestion = (symbol: string | null) => (symbol ? `Which range is this ${symbol} chart showing?` : "Which range is this chart showing?");

const NUMBER: Record<string, number> = { one: 1, a: 1, an: 1, two: 2, three: 3, five: 5, six: 6, twelve: 12 };

/** A range said or typed as the answer ("five days", "5D", "one month", "a year"); null for anything else. */
export function rangeFromAnswer(said: string): ChartRange | null {
  const t = said.toLowerCase().replace(/[.!?,]/g, " ").replace(/\s+/g, " ").trim().replace(/^(the |it's |its |it is |show |make it )+/, "");
  const m = /^(\d+|one|a|an|two|three|five|six|twelve) ?(d|day|days|w|wk|week|weeks|m|mo|month|months|y|yr|year|years)$/.exec(t);
  if (m) {
    const n = NUMBER[m[1]!] ?? Number(m[1]);
    const unit = m[2]![0];
    if (unit === "d") return n === 1 ? "1D" : n === 5 || n === 7 ? "1W" : null;
    if (unit === "w") return n === 1 ? "1W" : null;
    if (unit === "m") return n === 1 ? "1M" : n === 3 ? "3M" : n === 6 ? "6M" : n === 12 ? "1Y" : null;
    if (unit === "y") return n === 1 ? "1Y" : null;
  }
  if (/^(today|intraday|a day)$/.test(t)) return "1D";
  if (/^(this week|a week|the week)$/.test(t)) return "1W";
  if (/^(this month|a month)$/.test(t)) return "1M";
  if (/^(a year|this year|one year)$/.test(t)) return "1Y";
  return null;
}

/** What identifies the chart an answer is for: the tab's URL (it carries TradingView's symbol), the symbol, the range read. */
export const chartAskKey = (url: string, symbol: string | null, rangeRead: ChartRange | null) => `${url}|${symbol ?? ""}|${rangeRead ?? ""}`;

/** The answers given in this tab, by chart (chartAskKey): a new URL, symbol or range on the page misses, and asks again. */
export class ChartAnswers {
  private readonly answers = new Map<string, { symbol: string; range: ChartRange }>();
  get(key: string) {
    return this.answers.get(key) ?? null;
  }
  set(key: string, answer: { symbol: string; range: ChartRange }) {
    this.answers.delete(key);
    this.answers.set(key, answer);
    // A tab only needs its recent charts.
    while (this.answers.size > 20) this.answers.delete(this.answers.keys().next().value!);
  }
}
