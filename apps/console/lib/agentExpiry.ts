/**
 * An agent expiry the vault will accept. setAgent refuses an expiry more than MAX_AGENT_TTL (30 days) past the
 * block the transaction lands in. The console computes expiries from a block time read a moment earlier (never the
 * device clock), but a lagging RPC or a slow confirmation shouldn't be able to push one over, so every absolute
 * expiry the console builds stays at least SAFETY_MARGIN_SECONDS under the maximum.
 *
 * New vaults (GlanceVaultFactoryV2) don't need this: they send a duration, and the vault adds it to its own block time.
 */
export const MAX_AGENT_TTL_SECONDS = 30 * 86_400; // GlanceVault.MAX_AGENT_TTL
export const SAFETY_MARGIN_SECONDS = 10 * 60;

/** `now` (a block timestamp, seconds) plus `ttlSeconds`, capped at 30 days minus the 10-minute margin. */
export function safeAgentExpiry(now: number, ttlSeconds: number): bigint {
  const ttl = Math.min(ttlSeconds, MAX_AGENT_TTL_SECONDS - SAFETY_MARGIN_SECONDS);
  return BigInt(Math.floor(now) + Math.max(0, ttl));
}
