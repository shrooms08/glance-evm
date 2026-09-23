/** Development-only logging. Production builds stay silent in the host page's console. */
export const log = import.meta.env.DEV
  ? (...args: unknown[]) => console.debug("[glance]", ...args)
  : () => {};
