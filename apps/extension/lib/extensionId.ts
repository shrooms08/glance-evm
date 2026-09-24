/**
 * Glance's extension ID. It is fixed by the public `key` in wxt.config.ts (the ID is a hash of that key, not of the
 * folder it's loaded from), so every install has it: any folder, any profile, the judges' zip. The browser keeps the
 * microphone grant per extension origin (chrome-extension://<id>), so a fixed ID also keeps that grant across rebuilds.
 */
export const EXTENSION_ID = "gmcdcaoneeohbacbnafjdnkkoojgnogl";

/** The ID Chrome derives from a manifest `key`: the first 32 hex digits of SHA-256(key), each mapped 0-f to a-p. */
export async function idFromKey(base64Key: string): Promise<string> {
  const der = Uint8Array.from(atob(base64Key), (c) => c.charCodeAt(0));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", der));
  return [...digest]
    .slice(0, 16)
    .flatMap((b) => [b >> 4, b & 15])
    .map((n) => String.fromCharCode(97 + n))
    .join("");
}
