/**
 * Why voice did or didn't work, in one accurate sentence. Pure, so every branch is unit tested.
 *
 * Voice runs in the extension's own context (an offscreen document, or the side panel), so a website's microphone
 * policy can no longer be the reason. What can still stop it: the browser build has no speech recognition (Brave turns
 * it off; open-source Chromium builds lack Google's speech service), the user hasn't granted Glance the microphone yet,
 * or there is no microphone.
 */

export type BrowserName = "Google Chrome" | "Chromium" | "Brave" | "Microsoft Edge" | "Opera" | "Other";

export interface BrowserInfo {
  name: BrowserName;
  version: string;
}

interface NavLike {
  userAgent: string;
  userAgentData?: { brands?: Array<{ brand: string; version: string }> };
  brave?: unknown;
}

/** Chrome, Chromium, Brave, Edge or Opera, from userAgentData brands (with a userAgent fallback). */
export function detectBrowser(nav: NavLike): BrowserInfo {
  const brands = nav.userAgentData?.brands ?? [];
  const find = (b: string) => brands.find((x) => x.brand === b);
  if (nav.brave) return { name: "Brave", version: find("Brave")?.version ?? find("Chromium")?.version ?? "" };
  const edge = find("Microsoft Edge");
  if (edge) return { name: "Microsoft Edge", version: edge.version };
  const opera = find("Opera");
  if (opera) return { name: "Opera", version: opera.version };
  const chrome = find("Google Chrome");
  if (chrome) return { name: "Google Chrome", version: chrome.version };
  const chromium = find("Chromium");
  if (chromium) return { name: "Chromium", version: chromium.version };
  // Edge and Opera also carry "Chrome/", so the more specific tokens are checked first.
  const fallbacks: Array<[RegExp, BrowserName]> = [
    [/Edg\/(\d+)/, "Microsoft Edge"],
    [/OPR\/(\d+)/, "Opera"],
    [/Chromium\/(\d+)/, "Chromium"],
    [/Chrome\/(\d+)/, "Google Chrome"],
  ];
  for (const [re, name] of fallbacks) {
    const m = re.exec(nav.userAgent);
    if (m) return { name, version: m[1]! };
  }
  return { name: "Other", version: "" };
}

/**
 * Failure codes. The first group comes from our own checks before listening; the rest are the Web Speech API's own
 * SpeechRecognitionErrorEvent.error values.
 */
export type VoiceCode =
  | "no-recognition" // the browser build has no SpeechRecognition
  | "mic-not-enabled" // Glance hasn't been granted the microphone yet (permission "prompt")
  | "mic-denied" // the user blocked the microphone for Glance
  | "no-mic" // no audio input device
  | "offscreen-failed" // the extension could not start its voice worker
  | "network" // recognition started but its speech service is unreachable
  | "not-allowed"
  | "service-not-allowed"
  | "audio-capture"
  | "no-speech"
  | "language-not-supported"
  | "aborted"
  | string;

export function reasonFor(code: VoiceCode, browser: BrowserInfo): string {
  const isGoogleChrome = browser.name === "Google Chrome";
  switch (code) {
    case "no-recognition":
      if (browser.name === "Brave") return "Brave turns off speech recognition. Type instead, or use Google Chrome for voice.";
      return `This ${browser.name === "Other" ? "browser" : `${browser.name} build`} has no speech recognition. Google Chrome has it. Type instead.`;
    case "mic-not-enabled":
      return "I need microphone access. Click “Enable voice” in Glance's settings, then try again.";
    case "mic-denied":
    case "not-allowed":
      return "The microphone is blocked for Glance. Allow it for this extension in your browser's settings, then click “Enable voice” in Glance's settings.";
    case "no-mic":
    case "audio-capture":
      return "I can't find a microphone. Plug one in, or type instead.";
    case "network":
    case "service-not-allowed":
      if (browser.name === "Brave") return "Brave blocks the speech service. Type instead, or use Google Chrome for voice.";
      if (!isGoogleChrome) return `This ${browser.name} build has no speech service. Google Chrome has it. Type instead.`;
      return "Chrome couldn't reach its speech service. Check your connection, or type instead.";
    case "no-speech":
      return "I didn't hear anything. Hold the key and speak, or type instead.";
    case "language-not-supported":
      return "Speech recognition doesn't support your browser's language. Type instead.";
    case "offscreen-failed":
      return "Glance couldn't start its voice helper. Reload the extension, or type instead.";
    default:
      return "Voice stopped unexpectedly. Type your request instead.";
  }
}
