/**
 * A used-versus-cap bar. Width comes from integer basis points (lib/caps.ts), never from floating-point money. It's
 * decoration: the same numbers are always written next to it, so screen readers skip the bar.
 */
export function Meter({ usedBps, tone = "accent" }: { usedBps: number; tone?: "accent" | "guard" | "muted"; label?: string }) {
  const pct = Math.max(0, Math.min(10_000, usedBps)) / 100;
  return (
    <div className="meter" data-tone={tone} aria-hidden>
      <span style={{ width: `${pct}%` }} />
    </div>
  );
}
