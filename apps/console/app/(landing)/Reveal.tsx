"use client";
/**
 * The page's only scroll motion: each [data-reveal] block fades and rises a little as it comes into view, once. Nothing
 * is hidden until this script runs (no JavaScript, nothing hidden), and with prefers-reduced-motion nothing moves.
 */
import { useEffect } from "react";

export function Reveal() {
  useEffect(() => {
    if (typeof matchMedia !== "function" || typeof IntersectionObserver === "undefined") return;
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const root = document.querySelector(".landing");
    const blocks = [...document.querySelectorAll<HTMLElement>("[data-reveal]")];
    // Already on screen when the page loads: shown as is, never faded in.
    const below = blocks.filter((b) => b.getBoundingClientRect().top > innerHeight * 0.92);
    if (!root || below.length === 0) return;
    for (const b of below) b.classList.add("lp-hidden");
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          e.target.classList.remove("lp-hidden");
          io.unobserve(e.target);
        }
      },
      { rootMargin: "0px 0px -8% 0px", threshold: 0.08 },
    );
    for (const b of below) io.observe(b);
    return () => io.disconnect();
  }, []);
  return null;
}
