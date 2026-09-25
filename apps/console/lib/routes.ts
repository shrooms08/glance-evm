/**
 * The console's routes. "/" is the public landing page; the Dashboard is /dashboard. Every URL that opened the
 * Dashboard at "/" before still gets there: a "/" carrying the Dashboard's query parameters is redirected to
 * /dashboard with its query kept (Next keeps the query on a redirect). The paths the Glance extension opens are pinned
 * by test/routes.test.ts.
 */
export const DASHBOARD_PATH = "/dashboard";

/** Query parameters that only ever meant the Dashboard when they came on "/". */
export const DASHBOARD_QUERY_KEYS = ["glance", "vault", "dev"] as const;

export const DASHBOARD_REDIRECTS = DASHBOARD_QUERY_KEYS.map((key) => ({
  source: "/",
  has: [{ type: "query" as const, key }],
  destination: DASHBOARD_PATH,
  permanent: false,
}));
