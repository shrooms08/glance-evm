"use client";
import { useEffect, useState } from "react";

/** Unix seconds, refreshed every `everyMs`: time for display, read outside render so renders stay pure. */
export function useNow(everyMs = 30_000): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), everyMs);
    return () => clearInterval(id);
  }, [everyMs]);
  return now;
}
