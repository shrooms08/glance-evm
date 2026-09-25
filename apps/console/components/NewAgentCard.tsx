"use client";
import { zeroAddress, isAddressEqual, type Address } from "viem";

import { addressUrl } from "@/lib/chain";
import { shortAddress } from "@/lib/format";
import { needsNewAgent } from "@/lib/glanceAgent";

/**
 * "Approve new Glance agent": shown when the vault's agent isn't the one the Glance API trades from (its key was
 * rotated). One wallet signature, setAgent(newAgent, 29 days from chain time): the old key can't trade from the next
 * block, and every limit and allowlist stays as it is.
 */
export function NewAgentCard({
  vaultAgent,
  apiAgent,
  approve,
}: {
  vaultAgent: Address;
  apiAgent: Address | null;
  /** Sends setAgent(apiAgent, 29 days): one wallet prompt. Resolves true once sent. */
  approve(agent: Address): Promise<boolean>;
}) {
  if (!needsNewAgent(vaultAgent, apiAgent)) return null;
  const hadAgent = !isAddressEqual(vaultAgent, zeroAddress);
  return (
    <section className="card" aria-labelledby="new-agent-h">
      <h2 className="heading" id="new-agent-h">
        Approve new Glance agent
      </h2>
      <p className="body">
        Glance now trades from{" "}
        <a className="mono" href={addressUrl(apiAgent)} target="_blank" rel="noreferrer">
          {shortAddress(apiAgent)} ↗
        </a>
        {hadAgent ? (
          <>
            , but this vault still names {shortAddress(vaultAgent)}. Approve the new agent and the old one stops being able to trade in the next block.
          </>
        ) : (
          <>. This vault has no agent yet.</>
        )}
      </p>
      <p className="meta">One wallet signature. Your limits, stocks and routers stay exactly as they are; the new agent can trade for 29 days.</p>
      <div className="row wrap">
        <button className="btn" onClick={() => void approve(apiAgent)}>
          Approve new Glance agent
        </button>
      </div>
    </section>
  );
}
