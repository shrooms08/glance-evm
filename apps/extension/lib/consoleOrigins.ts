/**
 * Where the Glance console runs, so the extension can mark it as installed (Get started's step 5). Set at build time
 * with WXT_CONSOLE_ORIGINS, a comma-separated list of origins (scheme, host, optional port; no path), e.g.
 *   WXT_CONSOLE_ORIGINS=http://localhost:3000,https://glance-console.vercel.app
 * Default: http://localhost:3000 only. Each becomes the match pattern "<origin>/*". A malformed origin fails the build.
 */
export const DEFAULT_CONSOLE_ORIGINS = "http://localhost:3000";

export function consoleMatchPatterns(value: string | undefined = DEFAULT_CONSOLE_ORIGINS): string[] {
  const list = (value?.trim() ? value : DEFAULT_CONSOLE_ORIGINS)
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
  const patterns = list.map((origin) => {
    const m = /^(https?):\/\/([a-z0-9.-]+)(:\d{1,5})?\/?$/i.exec(origin);
    if (!m) throw new Error(`WXT_CONSOLE_ORIGINS: "${origin}" isn't an origin like https://console.example.com or http://localhost:3000`);
    return `${m[1]!.toLowerCase()}://${m[2]!.toLowerCase()}${m[3] ?? ""}/*`;
  });
  return [...new Set(patterns)];
}
