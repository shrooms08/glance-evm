/**
 * Glance's one offscreen document: it records push-to-talk audio (under the extension's own mic permission) and plays
 * the spoken replies. It is created once per browser session and kept open: never closed by Glance, and created with
 * the USER_MEDIA reason only. (Chrome closes a document created with AUDIO_PLAYBACK after 30 seconds without sound;
 * when it closed between uses, a Brave grant made "until I close this site" went with it, and Brave asked again.)
 * Each utterance stops its microphone tracks when it ends; the document, and with it the grant, stays.
 */
export const OFFSCREEN_REASONS = ["USER_MEDIA"] as const;
export const OFFSCREEN_JUSTIFICATION = "Records push-to-talk audio under Glance's own microphone permission, and plays Glance's spoken replies. Kept open so the permission isn't lost between uses.";

export interface OffscreenDeps {
  url: string;
  /** Existing offscreen documents at `url` (runtime.getContexts). */
  existing(): Promise<number>;
  create(o: { url: string; reasons: string[]; justification: string }): Promise<void>;
}

/** Creates the offscreen document if it isn't open, once even when asked many times at once. */
export function offscreenKeeper(d: OffscreenDeps) {
  let creating: Promise<void> | null = null;
  return async function ensure(): Promise<void> {
    if ((await d.existing()) > 0) return;
    creating ??= d.create({ url: d.url, reasons: [...OFFSCREEN_REASONS], justification: OFFSCREEN_JUSTIFICATION }).finally(() => {
      creating = null;
    });
    await creating;
  };
}
