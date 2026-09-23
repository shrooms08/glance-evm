/**
 * Two hotkeys, two verbs, both held with Option (Alt on Windows) and both remappable in settings:
 *   Option+G, tap:  GLANCE. Scan the page, open the panel, say what was found. Never listens.
 *   Option+V, hold: VOICE. Listening while held, sent on release.
 * Pure, so the key logic is unit tested.
 */

export const DEFAULT_GLANCE_KEY = "G";
export const DEFAULT_VOICE_KEY = "V";

export interface HotkeyLetters {
  glance: string;
  voice: string;
}

export interface KeyLike {
  code: string;
  key: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  repeat: boolean;
}

/** KeyboardEvent.code for a letter: layout-independent, and Option+letter on a Mac types a symbol in `key`. */
export const codeFor = (letter: string) => `Key${letter.toUpperCase()}`;

export const keyLabel = (letter: string) => `⌥ ${letter.toUpperCase()}`;

/** What a keydown means: "glance", "voice" (start holding), or null. Auto-repeat is ignored for both. */
export function hotkeyDown(e: KeyLike, keys: HotkeyLetters): "glance" | "voice" | null {
  if (!e.altKey || e.ctrlKey || e.metaKey || e.repeat) return null;
  if (e.code === codeFor(keys.voice)) return "voice";
  if (e.code === codeFor(keys.glance)) return "glance";
  return null;
}

/** Whether a keyup ends a voice hold: releasing the letter or Option, whichever comes first. */
export function endsVoiceHold(e: Pick<KeyLike, "code" | "key">, keys: HotkeyLetters): boolean {
  return e.code === codeFor(keys.voice) || e.key === "Alt";
}

/** Settings validation: one letter each, and not the same letter. */
export function hotkeyError(glance: string, voice: string): { glance?: string; voice?: string } {
  const out: { glance?: string; voice?: string } = {};
  if (!/^[A-Z]$/.test(glance)) out.glance = "Pick a single letter.";
  if (!/^[A-Z]$/.test(voice)) out.voice = "Pick a single letter.";
  if (!out.glance && !out.voice && glance === voice) out.voice = "Use a different letter from the glance key.";
  return out;
}

export interface FoundCompany {
  name: string;
  mentions: number;
}

/** What Option+G says: "Reading cnbc.com, 1 name found, Tesla 16×". Up to three names, most mentioned first. */
export function glanceLine(host: string, companies: FoundCompany[]): string {
  const where = host ? `Reading ${host}` : "Reading this page";
  if (companies.length === 0) return `${where}, no names found`;
  const count = `${companies.length} ${companies.length === 1 ? "name" : "names"} found`;
  const top = [...companies]
    .sort((a, b) => b.mentions - a.mentions)
    .slice(0, 3)
    .map((c) => `${c.name} ${c.mentions}×`)
    .join(", ");
  return `${where}, ${count}, ${top}`;
}
