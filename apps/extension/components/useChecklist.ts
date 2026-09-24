/** The "Getting started" checklist's state, live (it ticks itself off as things happen in any tab). */
import { useEffect, useState } from "react";

import { safely } from "../lib/lifecycle";
import { checklist, type ChecklistState } from "../lib/onboarding";

export function useChecklist(): ChecklistState | null {
  const [state, setState] = useState<ChecklistState | null>(null);
  useEffect(() => {
    let live = true;
    void safely(() => checklist.getValue(), Promise.resolve({} as ChecklistState)).then((v) => live && setState(v));
    const unwatch = safely(() => checklist.watch((v) => setState(v ?? {})), () => {});
    return () => {
      live = false;
      safely(unwatch, undefined);
    };
  }, []);
  return state;
}
