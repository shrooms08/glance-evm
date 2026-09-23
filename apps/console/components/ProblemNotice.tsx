"use client";
import { ApiProblem } from "@/lib/api";
import { env } from "@/lib/env";

import { Notice } from "./Notice";

/** Why a read failed, in the API's own words where there are some: never "something went wrong". */
export function ProblemNotice({ error, what = "this" }: { error: unknown; what?: string }) {
  if (error instanceof ApiProblem) {
    if (error.kind === "rpc") {
      return (
        <Notice tone="guard" title={error.message}>
          This is the network, not your vault. The console keeps checking and fills in on its own as soon as it answers.
        </Notice>
      );
    }
    if (error.kind === "unreachable") {
      return (
        <Notice tone="fail" title="The Glance API isn't reachable">
          {error.message} Locally, start it with <code>pnpm --filter api dev</code>. Deployed, check that{" "}
          <code>NEXT_PUBLIC_GLANCE_API_URL</code> ({env.apiUrl}) is right and that the API's <code>CORS_ORIGINS</code> includes
          this site. The console retries on its own.
        </Notice>
      );
    }
    if (error.kind === "not-a-vault") {
      return (
        <Notice tone="guard" title="That address isn't a Glance vault">
          {error.message} The chain answered: there's no Glance vault there. Pick a vault from the switcher above.
        </Notice>
      );
    }
    return <Notice tone="fail" title={`Couldn't load ${what}`}>{error.message}</Notice>;
  }
  return <Notice tone="fail" title={`Couldn't load ${what}`}>{(error as Error)?.message ?? "Unknown error."}</Notice>;
}
