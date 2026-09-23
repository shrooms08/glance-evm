import type { ReactNode } from "react";

/**
 * A state the page is in, said plainly. Tones: "guard" (amber: a protection or a condition to fix), "fail" (a
 * transaction or read that failed), "info" (neutral), "ok" (lime: it worked).
 */
export function Notice({
  tone = "info",
  title,
  children,
  action,
  role,
}: {
  tone?: "guard" | "fail" | "info" | "ok";
  title: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  role?: "status" | "alert";
}) {
  return (
    <div className="notice" data-tone={tone} role={role ?? (tone === "fail" ? "alert" : "status")}>
      <span className="notice-dot" aria-hidden />
      <div className="notice-body">
        <p className="notice-title">{title}</p>
        {children && <div className="notice-text">{children}</div>}
      </div>
      {action && <div className="notice-action">{action}</div>}
    </div>
  );
}
