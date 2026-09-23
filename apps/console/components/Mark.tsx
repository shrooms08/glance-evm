/** The Glance orb: the black disc with the eye, as in the extension (in-page surfaces are always dark). */
export function Mark({ size = 28, state }: { size?: number; state?: "idle" | "live" | "blocked" }) {
  return (
    <span className="mark" data-state={state ?? "idle"} style={{ width: size, height: size }} aria-hidden>
      <span className="mark-eye" />
    </span>
  );
}
