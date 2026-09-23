"use client";
/**
 * The wallet stack (wagmi, RainbowKit and the wallet SDKs under them) runs in the browser only: the console reads
 * everything client-side anyway, and some wallet SDKs' server builds pull in modules the console never uses.
 */
import dynamic from "next/dynamic";
import { Suspense, type ReactNode } from "react";

import { Mark } from "./Mark";

const Providers = dynamic(() => import("./Providers").then((m) => m.Providers), { ssr: false, loading: () => <Boot /> });
const Shell = dynamic(() => import("./Shell").then((m) => m.Shell), { ssr: false });

function Boot() {
  return (
    <div className="boot" aria-busy="true" aria-label="Loading the Glance console">
      <Mark size={40} />
    </div>
  );
}

export function ClientRoot({ children }: { children: ReactNode }) {
  return (
    <Providers>
      <Suspense fallback={<Boot />}>
        <Shell>{children}</Shell>
      </Suspense>
    </Providers>
  );
}
