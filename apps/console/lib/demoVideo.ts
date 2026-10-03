/**
 * The landing page's demo video: NEXT_PUBLIC_DEMO_VIDEO_URL, a YouTube or Loom link in any of their usual forms,
 * turned into an embeddable address. Anything else (or nothing) shows the design's placeholder.
 */
export type DemoEmbed = { provider: "youtube" | "loom"; src: string } | null;

const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
const LOOM_ID = /^[A-Za-z0-9]{16,64}$/;

export function demoEmbed(raw: string | undefined | null): DemoEmbed {
  if (!raw?.trim()) return null;
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "https:") return null;
  const host = u.hostname.replace(/^www\.|^m\./, "");
  const parts = u.pathname.split("/").filter(Boolean);
  let youtube: string | null = null;
  if (host === "youtu.be") youtube = parts[0] ?? null;
  else if (host === "youtube.com" || host === "youtube-nocookie.com") {
    if (parts[0] === "watch") youtube = u.searchParams.get("v");
    else if (parts[0] === "embed" || parts[0] === "shorts" || parts[0] === "live") youtube = parts[1] ?? null;
  }
  if (youtube && YOUTUBE_ID.test(youtube)) return { provider: "youtube", src: `https://www.youtube-nocookie.com/embed/${youtube}?rel=0` };
  if (host === "loom.com" && (parts[0] === "share" || parts[0] === "embed") && parts[1] && LOOM_ID.test(parts[1])) {
    return { provider: "loom", src: `https://www.loom.com/embed/${parts[1]}` };
  }
  return null;
}

/** The video the landing page links to when NEXT_PUBLIC_DEMO_VIDEO_URL isn't set (the published demo on YouTube). */
export const DEMO_VIDEO_FALLBACK = "https://www.youtube.com/watch?v=KwPYiDraE2I";

/**
 * Where "Watch the demo" goes: the same video, as its own page on YouTube or Loom (opened in a new tab, never embedded).
 * Anything that isn't a YouTube or Loom link falls back to the published demo.
 */
export function demoWatchUrl(raw: string | undefined | null): string {
  const embed = demoEmbed(raw);
  if (embed?.provider === "youtube") return `https://www.youtube.com/watch?v=${/embed\/([A-Za-z0-9_-]{11})/.exec(embed.src)![1]}`;
  if (embed?.provider === "loom") return embed.src.replace("/embed/", "/share/");
  return DEMO_VIDEO_FALLBACK;
}
