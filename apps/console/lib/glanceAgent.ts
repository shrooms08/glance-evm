/**
 * Which agent Glance trades from right now: the API's own key, as its /health reports it (an address, public by nature;
 * shown in production too). The deployment record names the agent the demo vaults started with; after the API's agent
 * key is rotated, vaults approve the new address with one setAgent call (GlanceVault.setAgent: owner only, replaces the
 * agent in place, keeps every limit, allowlist and the rolling spend windows).
 */
import { getAddress, isAddress, isAddressEqual, type Address } from "viem";

import type { HealthView } from "./api";
import type { DemoVault } from "./deployment";

/** The API's live agent, or null (no key loaded, or /health not answered yet): then nothing is suggested. */
export function glanceAgent(health: Pick<HealthView, "agent"> | undefined | null): Address | null {
  const a = health?.agent;
  if (!a?.keyLoaded || !a.address || !isAddress(a.address, { strict: false })) return null;
  return getAddress(a.address);
}

/** The vault still names another agent (an older key, or none) while the API trades from `apiAgent`. */
export function needsNewAgent(vaultAgent: Address, apiAgent: Address | null): apiAgent is Address {
  return apiAgent !== null && !isAddressEqual(vaultAgent, apiAgent);
}

/** A setup flavour that authorises the API's live agent (the deployment's agent when the API hasn't said). */
export const withGlanceAgent = (flavour: DemoVault, apiAgent: Address | null): DemoVault => (apiAgent ? { ...flavour, agent: apiAgent } : flavour);
