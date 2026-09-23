/** Loading placeholders in the shape of what's coming, so nothing jumps when it arrives. */
export function Skeleton({ lines = 3, tall = false }: { lines?: number; tall?: boolean }) {
  return (
    <div className="skeleton" aria-busy="true" aria-label="Loading">
      {Array.from({ length: lines }, (_, i) => (
        <span key={i} className={tall && i === 0 ? "is-tall" : undefined} />
      ))}
    </div>
  );
}
