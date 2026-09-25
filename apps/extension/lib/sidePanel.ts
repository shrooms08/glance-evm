/** A side panel Glance can open: the API exists and has open() (Arc, among others, has neither). */
export function sidePanelSupported(sidePanel: unknown): boolean {
  return typeof (sidePanel as { open?: unknown } | undefined)?.open === "function";
}
