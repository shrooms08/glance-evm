/**
 * Every error an owner flow catches is shown on the page AND logged here, once, so nothing is ever swallowed:
 * console.error("[glance-console]", context, error). Never logs keys (the console holds none) or page text.
 */
export function reportError(context: string, error: unknown): void {
  // eslint-disable-next-line no-console
  console.error("[glance-console]", context, error);
}
