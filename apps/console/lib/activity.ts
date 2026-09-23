import type { ActivityItem } from "./api";

/** Four or more owner changes in a row (typically a vault being set up) fold into one line, so trades and refusals stand out. */
export function foldOwnerRuns(items: ActivityItem[], min = 4): Array<ActivityItem | ActivityItem[]> {
  const out: Array<ActivityItem | ActivityItem[]> = [];
  let run: ActivityItem[] = [];
  const flush = () => {
    if (run.length >= min) out.push(run);
    else out.push(...run);
    run = [];
  };
  for (const item of items) {
    if (item.kind === "owner") run.push(item);
    else {
      flush();
      out.push(item);
    }
  }
  flush();
  return out;
}
