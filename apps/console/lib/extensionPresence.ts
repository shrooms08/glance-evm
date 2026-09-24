"use client";
/**
 * Whether the Glance extension is in this browser: its console-marker content script marks <html data-glance-extension>
 * on the console's own origins. Watched, so a page notices the moment Glance is installed or reloaded.
 */
import { useEffect, useState } from "react";

export function useExtensionInstalled(): boolean {
  const [installed, setInstalled] = useState(false);
  useEffect(() => {
    const el = document.documentElement;
    const check = () => setInstalled(el.dataset.glanceExtension === "installed");
    const obs = new MutationObserver(check);
    obs.observe(el, { attributes: true, attributeFilter: ["data-glance-extension"] });
    const id = setTimeout(check, 0);
    return () => {
      obs.disconnect();
      clearTimeout(id);
    };
  }, []);
  return installed;
}
