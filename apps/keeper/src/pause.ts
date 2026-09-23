/**
 * The pause switch. While paused the keeper writes nothing, so a feed deliberately frozen for the "simulate weekend"
 * demo (make weekend) is not overwritten by the next mirror pass.
 *
 * Paused when either:
 *  - the file keeper.paused exists at the repo root (make keeper-pause creates it; commit and push it to pause the
 *    scheduled GitHub Actions keeper as well), or
 *  - KEEPER_PAUSED is set to 1 or true.
 */
export interface PauseState {
  paused: boolean;
  reason: string;
}

export function pauseState(env: { KEEPER_PAUSED?: string | undefined }, pauseFileExists: boolean, pauseFile: string): PauseState {
  const flag = (env.KEEPER_PAUSED ?? "").trim().toLowerCase();
  if (flag === "1" || flag === "true") return { paused: true, reason: "KEEPER_PAUSED is set" };
  if (pauseFileExists) return { paused: true, reason: `${pauseFile} exists` };
  return { paused: false, reason: "" };
}
