/** A used-versus-cap bar. Width comes from integer basis points (lib/caps.ts), never from floating-point money. */
export function Meter({ usedBps, tone = "accent", label }: { usedBps: number; tone?: "accent" | "guard" | "muted"; label: string }) {
  const pct = Math.max(0, Math.min(10_000, usedBps)) / 100;
  return (
    <div className="meter" data-tone={tone} role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
      <span style={{ width: `${pct}%` }} />
    </div>
  );
}
