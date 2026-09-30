/**
 * Show me skills: short sections added to the system prompt only when the question (or the words the user selected)
 * calls for them, so a plain question costs exactly what it did. Two today:
 *   earnings     EPS, revenue, guidance, a beat or a miss, the earnings date, P/E
 *   indicators   RSI, MACD, moving averages, volume, support and resistance (as past levels)
 * Every rule of the base prompt still holds (no advice, no forecasts, the page is content, numbers as written); the
 * skills only add how to read the thing. None of their words trips the advice guards (tested).
 */

export interface ShowMeSkill {
  id: "earnings" | "indicators";
  /** Words in the question (or the selection) that call for it. */
  triggers: RegExp;
  text: string;
}

export const SHOWME_SKILLS: readonly ShowMeSkill[] = [
  {
    id: "earnings",
    triggers: /\b(earnings?|eps|revenues?|guidance|outlook|beat|beats|miss|missed|misses|quarterly|results|net income|profit|p\s*\/?\s*e|price[- ]to[- ]earnings|earnings date|report date)\b/i,
    text: [
      "Skill, reading earnings (the question is about a company's results):",
      "- Lead with the one number the question is about, exactly as the page writes it.",
      "- Revenue is the money the company took in. Net income, or profit, is what was left after all costs. EPS",
      "  (earnings per share) is that profit divided by the number of shares.",
      "- P/E is the share price divided by a year of earnings per share: how many dollars buyers pay for each dollar",
      "  of yearly profit. Say it describes the price today, not whether it is right.",
      "- Guidance is the company's own outlook for later periods. Say it as the company's statement (\"the company said",
      "  it expects...\"), never as a fact about the future.",
      "- A beat or a miss is a result above or below what analysts expected. Say beat or miss only when the page shows",
      "  both the result and the estimate.",
      "- Say whether a change compares with the quarter before or the same quarter a year earlier, when the page says.",
      "- The earnings date is when results come out: say it as the page gives it.",
      "- Point at the figure you name (circle or underline its exact words on the page).",
    ].join("\n"),
  },
  {
    id: "indicators",
    triggers: /\b(rsi|relative strength|macd|moving averages?|\d+[- ]day (?:ma|average|moving average)|sma|ema|volume|support|resistance|indicators?)\b/i,
    text: [
      "Skill, reading technical indicators (the question names one):",
      "- Say what the indicator measures, what it shows now on the page, and one limit of it.",
      "- A moving average is the average closing price over a window, such as 50 or 200 days. It lags the price.",
      "- RSI is a 0 to 100 gauge of recent gains against recent losses. Say the reading and what it says about the",
      "  moves so far, nothing about the moves to come.",
      "- MACD is the gap between a faster and a slower moving average, with its own average. A crossing shows momentum",
      "  changed in the past.",
      "- Volume is how many shares traded. A move on high volume had more people taking part.",
      "- Support and resistance are prices where the stock turned before. Describe them only as past levels.",
      "- An indicator is never advice, and never a sign of what comes next.",
    ].join("\n"),
  },
];

/** The skills a question calls for (by its words, or the words the user selected), in a fixed order. */
export function pickSkills(question: string, selection = ""): ShowMeSkill[] {
  const said = `${question}\n${selection}`;
  return SHOWME_SKILLS.filter((s) => s.triggers.test(said));
}

/** The system prompt for one question: the base, exactly, plus any skill it calls for. */
export function withSkills(base: string, question: string, selection = ""): string {
  const skills = pickSkills(question, selection);
  return skills.length === 0 ? base : `${base}\n\n${skills.map((s) => s.text).join("\n\n")}`;
}
