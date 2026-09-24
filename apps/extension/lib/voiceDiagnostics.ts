/**
 * Voice diagnostics, each checked separately. Run these in an extension page (settings, side panel, offscreen), where
 * the microphone permission is Glance's own, not a website's.
 */
import { detectBrowser, type BrowserInfo } from "./voiceReasons";

export type MicPermission = "granted" | "prompt" | "denied" | "unknown";

export interface VoiceDiagnostics {
  browser: BrowserInfo;
  /** SpeechRecognition (or webkitSpeechRecognition) exists in this build. */
  recognition: boolean;
  micPermission: MicPermission;
  /** An audio input device is present. null when it can't be known without permission. */
  micDevice: boolean | null;
}

export function hasRecognition(): boolean {
  const w = globalThis as unknown as { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown };
  return Boolean(w.SpeechRecognition ?? w.webkitSpeechRecognition);
}

export async function micPermission(): Promise<MicPermission> {
  try {
    const p = await navigator.permissions.query({ name: "microphone" as PermissionName });
    return p.state as MicPermission;
  } catch {
    return "unknown";
  }
}

export async function micDevicePresent(): Promise<boolean | null> {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const inputs = devices.filter((d) => d.kind === "audioinput");
    if (inputs.length > 0) return true;
    return false;
  } catch {
    return null;
  }
}

export async function diagnose(): Promise<VoiceDiagnostics> {
  const [permission, device] = await Promise.all([micPermission(), micDevicePresent()]);
  return {
    browser: detectBrowser(navigator as unknown as Parameters<typeof detectBrowser>[0]),
    recognition: hasRecognition(),
    micPermission: permission,
    micDevice: device,
  };
}

/** Asks for the microphone on behalf of the extension (shows the browser's prompt), then releases it. */
export async function requestMic(): Promise<MicPermission> {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
    return "granted";
  } catch (err) {
    const name = (err as DOMException).name;
    if (name === "NotFoundError" || name === "OverconstrainedError") return "prompt";
    return "denied";
  }
}

/**
 * What would stop listening right now, before touching the microphone: no recognition in this build, the permission
 * not granted yet, the permission blocked, or no microphone. null means go ahead.
 */
export async function voiceBlocker(): Promise<import("./voiceReasons").VoiceCode | null> {
  if (!hasRecognition()) return "no-recognition";
  const permission = await micPermission();
  if (permission === "denied") return "mic-denied";
  if (permission === "prompt") return "mic-not-enabled";
  if ((await micDevicePresent()) === false) return "no-mic";
  return null;
}
