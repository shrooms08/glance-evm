"use client";
import { useQueryClient } from "@tanstack/react-query";
import { isRpcTrouble, RPC_TROUBLE_MESSAGE } from "@glance/core/rpc";
import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { zeroAddress, type Address } from "viem";
import { useAccount } from "wagmi";

import { Notice } from "@/components/Notice";
import { TxStatus } from "@/components/TxStatus";
import { useGate } from "@/components/useGate";
import { addressUrl } from "@/lib/chain";
import { CHAIN_ID, demoVaults, primaryVault, type DemoVault } from "@/lib/deployment";
import { formatUsd, parseDecimal, shortAddress } from "@/lib/format";
import { planSetup, vaultReady, type SetupStep } from "@/lib/setup";
import { useOwnerTx } from "@/lib/useOwnerTx";
import { readStartState, useStartState } from "@/lib/useSetupSnapshot";
import { useHref } from "@/lib/vault";

export default function StartPage() {
  const { address, isConnected, chainId } = useAccount();
  const gate = useGate(address);
  const [flavourKey, setFlavourKey] = useState<DemoVault["key"]>(primaryVault.key);
  const flavour = demoVaults.find((d) => d.key === flavourKey)!;
  const q = useStartState(address, flavour);
  const extension = useExtensionInstalled();
  const onChain = chainId === CHAIN_ID;
  const s = q.data;
  const effective = s?.vaultFlavour ?? flavour;
  const decimals = s?.usdgDecimals[effective.key] ?? 6;

  const done = {
    connect: isConnected,
    network: isConnected && onChain,
    funds: Boolean(s && s.eth > 0n && (s.usdg.paxos > 0n || s.usdg.test > 0n || s.snapshot.vaultUsdgBalance > 0n)),
    vault: Boolean(s && vaultReady(s.snapshot, effective, decimals)),
    extension,
  };
  const count = Object.values(done).filter(Boolean).length;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <p className="eyebrow">Get started</p>
          <h1 className="title">Five steps to your own vault</h1>
          <p className="meta">Each step is checked against the chain, not remembered by this page, so it's right on any device.</p>
        </div>
        <div className="progress" aria-label={`${count} of 5 done`}>
          <span className="figure">{count}</span>
          <span className="meta">of 5 done</span>
        </div>
      </div>
      {q.error && (
        <Notice tone={isRpcTrouble(q.error) ? "guard" : "fail"} title={isRpcTrouble(q.error) ? RPC_TROUBLE_MESSAGE : "Couldn't read your wallet's state"}>
          {isRpcTrouble(q.error) ? "The steps below fill in on their own as soon as it answers." : (q.error as Error).message}
        </Notice>
      )}

      <ol className="steps">
        <Step n={1} title="Connect your wallet" done={done.connect}>
          <p className="meta">A browser wallet: MetaMask, Rabby, Brave Wallet or Coinbase Wallet. Glance never holds your key.</p>
          {!done.connect && (
            <button className="btn btn-primary" onClick={gate.onConnect}>
              Connect wallet
            </button>
          )}
          {address && <p className="meta mono">{address}</p>}
        </Step>

        <Step n={2} title="Add Robinhood Chain testnet" done={done.network}>
          <p className="meta">Chain 46630. One click adds it to your wallet if it's missing and switches to it.</p>
          {isConnected && !onChain && (
            <button className="btn btn-primary" onClick={gate.onSwitchNetwork} disabled={gate.switching}>
              {gate.switching ? "Check your wallet…" : "Add and switch"}
            </button>
          )}
        </Step>

        <Step n={3} title="Get test ETH and USDG" done={done.funds}>
          <ul className="checks">
            <Check ok={Boolean(s && s.eth > 0n)}>
              Test ETH for gas: <a href="https://faucet.testnet.chain.robinhood.com" target="_blank" rel="noreferrer">faucet.testnet.chain.robinhood.com ↗</a>
            </Check>
            <Check ok={Boolean(s && s.usdg.paxos > 0n)}>
              Paxos USDG: <a href="https://faucet.paxos.com/" target="_blank" rel="noreferrer">faucet.paxos.com ↗</a> (choose Robinhood Chain testnet)
              {s && s.usdg.paxos > 0n && <span className="meta mono"> · you hold {formatUsd(s.usdg.paxos, s.usdgDecimals.paxos)}</span>}
            </Check>
          </ul>
          <p className="meta">No Paxos USDG? The TestUSDG fallback has its own on-chain faucet: pick it in step 4 and the setup takes it for you.</p>
        </Step>

        <Step n={4} title="Create your vault and fund it" done={done.vault}>
          <CreateVault owner={address} flavour={flavour} setFlavour={setFlavourKey} state={s} ready={onChain && isConnected} refetch={() => q.refetch()} />
        </Step>

        <Step n={5} title="Install the Glance extension" done={done.extension}>
          <p className="meta">
            Build it with <code>pnpm --filter extension build</code> and load <code>apps/extension/.output/chrome-mv3</code> as an unpacked extension (Brave,
            Arc, Chrome). In its settings, paste your vault's address. Then tap Option + G on any article.
          </p>
          <p className="meta">{extension ? "Detected on this page." : "Not detected on this page yet. (The extension marks the console when it's installed; this step isn't on chain.)"}</p>
        </Step>
      </ol>
    </div>
  );
}

function Step({ n, title, done, children }: { n: number; title: string; done: boolean; children: ReactNode }) {
  return (
    <li className="step" data-done={done || undefined}>
      <span className="step-n" aria-hidden>
        {done ? "✓" : n}
      </span>
      <div className="step-body">
        <div className="between">
          <h2 className="heading">{title}</h2>
          <span className={`chip ${done ? "chip-accent" : ""}`}>{done ? "Done" : "Not done"}</span>
        </div>
        {children}
      </div>
    </li>
  );
}

function Check({ ok, children }: { ok: boolean; children: ReactNode }) {
  return (
    <li className="check" data-ok={ok || undefined}>
      <span aria-hidden>{ok ? "✓" : "○"}</span>
      <span>{children}</span>
    </li>
  );
}

function CreateVault({
  owner,
  flavour,
  setFlavour,
  state,
  ready,
  refetch,
}: {
  owner: Address | undefined;
  flavour: DemoVault;
  setFlavour(k: DemoVault["key"]): void;
  state: Awaited<ReturnType<typeof readStartState>> | undefined;
  ready: boolean;
  refetch(): void;
}) {
  const effective = state?.vaultFlavour ?? flavour;
  const decimals = state?.usdgDecimals[effective.key] ?? 6;
  const [deposit, setDeposit] = useState("10");
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const tx = useOwnerTx(decimals);
  const href = useHref();
  const queryClient = useQueryClient();

  let depositRaw = 0n;
  let depositError: string | null = null;
  try {
    depositRaw = parseDecimal(deposit.replace(/^\$/, ""), decimals);
  } catch {
    depositError = `Enter an amount in USDG, up to ${decimals} decimal places.`;
  }
  const plan = state ? planSetup(state.snapshot, { flavour: effective, testUsdg: effective.key === "test", usdgDecimals: decimals, deposit: depositRaw }) : null;
  const vault = state?.snapshot.vault ?? null;

  /** Runs the plan one transaction at a time, re-reading the chain before each, until nothing is left (or one fails). */
  const run = async () => {
    if (!owner) return;
    setRunning(true);
    setRunError(null);
    let toDeposit = depositRaw;
    try {
      for (let guard = 0; guard < 20; guard++) {
        const fresh = await readStartState(owner, flavour);
        const f = fresh.vaultFlavour ?? flavour;
        const next = planSetup(fresh.snapshot, { flavour: f, testUsdg: f.key === "test", usdgDecimals: fresh.usdgDecimals[f.key], deposit: toDeposit });
        if (next.blocked) {
          setRunError(next.blocked);
          break;
        }
        const step: SetupStep | undefined = next.steps[0];
        if (!step) break;
        const address = step.call.address ?? fresh.snapshot.vault;
        if (!address) break;
        const args = step.id === "allow" ? [fresh.snapshot.vault ?? zeroAddress, toDeposit] : step.call.args;
        const ok = await tx.send({ label: step.label, address, abi: step.call.abi, functionName: step.call.functionName, args });
        if (!ok) break;
        if (step.id === "deposit") toDeposit = 0n;
      }
    } catch (err) {
      setRunError(isRpcTrouble(err) ? RPC_TROUBLE_MESSAGE : (err as Error).message);
    } finally {
      setRunning(false);
      await queryClient.invalidateQueries();
      refetch();
    }
  };

  return (
    <div className="create">
      <p className="meta">
        Exactly what <code>make create-vault</code> does: the vault, the five stocks with their price feeds and freshness (20 hours open, 96 hours
        closed), the stock desk, the Glance agent for 29 days, then your deposit. It starts with the vault's default limits: $100 a trade, $500 a day
        each way, 1% slippage, 25% while the market's closed. Change them any time under Limits.
      </p>
      {!state?.vaultFlavour && (
        <div className="segmented" role="radiogroup" aria-label="Which USDG">
          {demoVaults.map((d) => (
            <button key={d.key} role="radio" aria-checked={flavour.key === d.key} className="segment" onClick={() => setFlavour(d.key)} disabled={running}>
              {d.usdgLabel}
              {d.primary ? " (recommended)" : ""}
            </button>
          ))}
        </div>
      )}
      {vault && (
        <p className="meta">
          Your vault:{" "}
          <Link className="mono" href={href("/", vault)}>
            {shortAddress(vault)}
          </Link>{" "}
          on {effective.usdgLabel} ·{" "}
          <a className="mono" href={addressUrl(vault)} target="_blank" rel="noreferrer">
            explorer ↗
          </a>
        </p>
      )}
      <div className="field field-inline">
        <label htmlFor="deposit" className="ui">
          Deposit
        </label>
        <div className="input-unit" data-unit="$">
          <span aria-hidden>$</span>
          <input id="deposit" className="input mono" inputMode="decimal" value={deposit} onChange={(e) => setDeposit(e.target.value)} disabled={running} />
        </div>
        <span className={depositError ? "meta text-fail" : "meta"}>{depositError ?? `${effective.usdgLabel}, from your wallet into the vault.`}</span>
      </div>
      {plan && plan.steps.length > 0 && (
        <ol className="plan">
          {plan.steps.map((st) => (
            <li key={st.id} className="meta">
              {st.label}
            </li>
          ))}
        </ol>
      )}
      {plan && plan.steps.length === 0 && !plan.blocked && <p className="meta">Everything is in place.</p>}
      {plan?.blocked && <Notice tone="guard" title="Can't finish yet">{plan.blocked}</Notice>}
      {runError && runError !== plan?.blocked && <Notice tone="fail" title="Setup stopped">{runError}</Notice>}
      <TxStatus state={tx.state} />
      <div className="row wrap">
        <button className="btn btn-primary" onClick={() => void run()} disabled={!ready || running || !plan || plan.steps.length === 0 || Boolean(depositError) || Boolean(plan.blocked)}>
          {running ? "Setting up…" : vault ? "Finish setup" : "Create my vault"}
        </button>
        {!ready && <span className="meta">Connect and switch to Robinhood Chain testnet first.</span>}
        {plan && plan.steps.length > 0 && <span className="meta">{plan.steps.length} wallet confirmations, one at a time.</span>}
      </div>
    </div>
  );
}

/** The Glance extension marks the console page when it's installed (it looks for the glance-console meta tag). */
function useExtensionInstalled(): boolean {
  const [installed, setInstalled] = useState(false);
  useEffect(() => {
    const el = document.documentElement;
    const check = () => setInstalled(el.dataset.glanceExtension === "installed");
    check();
    const obs = new MutationObserver(check);
    obs.observe(el, { attributes: true, attributeFilter: ["data-glance-extension"] });
    return () => obs.disconnect();
  }, []);
  return installed;
}
