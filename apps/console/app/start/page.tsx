"use client";
import { isRpcTrouble, RPC_TROUBLE_MESSAGE } from "@glance/core/rpc";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Address, Hex } from "viem";
import { useAccount } from "wagmi";

import { Notice } from "@/components/Notice";
import { TxStatus } from "@/components/TxStatus";
import { useGate } from "@/components/useGate";
import { VaultStep } from "@/components/VaultStep";
import { CHAIN_ID, demoVaults, primaryVault, type DemoVault } from "@/lib/deployment";
import { formatUsd, parseDecimal } from "@/lib/format";
import { SingleFlight } from "@/lib/singleFlight";
import { addMorePlan, setupPlan } from "@/lib/setup";
import { STATUS_LABELS, stepStatuses, summarize, vaultProgress, type Activity, type StepStatus, type StatusInputs } from "@/lib/setupStatus";
import { describeTxError } from "@/lib/txMessages";
import { useOwnerTx } from "@/lib/useOwnerTx";
import { readStartState, useStartState } from "@/lib/useSetupSnapshot";
import { useHref } from "@/lib/vault";

type RunMode = "setup" | "add-more";

function parseAmount(value: string, decimals: number): { raw: bigint; error: string | null } {
  const text = value.trim().replace(/^\$/, "").replace(/,/g, "");
  if (!text) return { raw: 0n, error: null };
  try {
    return { raw: parseDecimal(text, decimals), error: null };
  } catch {
    return { raw: 0n, error: `Enter an amount in USDG, up to ${decimals} decimal places.` };
  }
}

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
  const tx = useOwnerTx(decimals);
  const queryClient = useQueryClient();
  const href = useHref();

  const [deposit, setDeposit] = useState("10");
  const [addMore, setAddMore] = useState("");
  const [running, setRunning] = useState<RunMode | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  // A deposit confirmed in this session, for the wallet that made it (switching accounts never carries it over).
  const [confirmedDeposit, setConfirmedDeposit] = useState<{ owner: string; hash: Hex } | null>(null);
  const depositConfirmed = Boolean(address && confirmedDeposit?.owner === address);
  const depositHash = depositConfirmed ? confirmedDeposit!.hash : null;
  // Which kind of run the last transaction came from: a failed "Add more" must not mark step 4 as failed.
  const [lastMode, setLastMode] = useState<RunMode | null>(null);
  // One run at a time: a double click lands before React re-renders, and must never start a second run.
  const flight = useRef(new SingleFlight());

  const first = parseAmount(deposit, decimals);
  const more = parseAmount(addMore, decimals);
  const plan = s ? setupPlan(s.snapshot, effective, decimals, first.raw, depositConfirmed) : null;
  const morePlan = s && more.raw > 0n ? addMorePlan(s.snapshot, effective, decimals, more.raw) : null;

  // What's in flight, and for which step. An "Add more" deposit is its own action: it never moves step 4's status.
  const inFlight = tx.state.status === "checking" || tx.state.status === "wallet" ? "wallet" : tx.state.status === "pending" ? "confirming" : null;
  let activity: Activity = { step: null, phase: "idle" };
  if (gate.switching) activity = { step: "network", phase: "wallet" };
  else if (running === "setup") activity = { step: "vault", phase: inFlight ?? "confirming" };
  else if (tx.state.status === "failed" && lastMode === "setup") activity = { step: "vault", phase: "failed" };

  const inputs: StatusInputs = {
    connected: isConnected,
    onChain,
    chain: s ? { eth: s.eth, walletUsdg: s.usdg[effective.key], snapshot: s.snapshot, flavour: effective, usdgDecimals: decimals } : undefined,
    depositConfirmed,
    extension,
    activity,
  };
  const statuses = stepStatuses(inputs);
  const summary = summarize(statuses);
  const busy = running !== null || tx.busy;

  /**
   * Runs one action to the end, a wallet confirmation at a time. Before every transaction it re-reads the chain and
   * re-plans, so nothing already in place is sent again; a step confirmed in this run is never repeated even if a
   * lagging RPC hasn't caught up yet. Setup deposits only while the vault holds nothing; "Add more" deposits once.
   */
  function run(mode: RunMode, amount: bigint) {
    if (!address) return;
    void flight.current.run(() => runSteps(address, mode, amount));
  }

  async function runSteps(owner: Address, mode: RunMode, amount: bigint) {
    setLastMode(mode);
    setRunning(mode);
    setRunError(null);
    const confirmed = new Set<string>();
    let deposited = depositConfirmed;
    try {
      for (let guard = 0; guard < 25; guard++) {
        let fresh = await readStartState(owner, flavour);
        // Just created: give the RPC a moment to show the new vault before planning its configuration.
        const created = confirmed.has("create") || confirmed.has("create-configured");
        if (created) {
          for (let wait = 0; !fresh.snapshot.vault && wait < 5; wait++) {
            await new Promise((r) => setTimeout(r, 1_000));
            fresh = await readStartState(owner, flavour);
          }
        }
        // Created in this run but the RPC still can't see it: stop rather than plan a second vault. The page
        // refreshes on its own; the factory would refuse a second vault anyway (VaultAlreadyExists).
        if (created && !fresh.snapshot.vault) break;
        const f = fresh.vaultFlavour ?? flavour;
        const dec = fresh.usdgDecimals[f.key];
        const next = mode === "setup" ? setupPlan(fresh.snapshot, f, dec, amount, deposited) : addMorePlan(fresh.snapshot, f, dec, amount);
        if (next.blocked) {
          setRunError(next.blocked);
          break;
        }
        const step = next.steps.find((st) => !confirmed.has(st.id));
        if (!step) break;
        const target = step.call.address ?? fresh.snapshot.vault;
        if (!target || (!fresh.snapshot.vault && step.id !== "create")) break;
        const args = step.id === "allow" ? [fresh.snapshot.vault, step.call.args[1]] : step.call.args;
        const hash = await tx.send({ label: step.label, address: target, abi: step.call.abi, functionName: step.call.functionName, args });
        if (!hash) break; // failed or cancelled: TxStatus says why; nothing else is sent
        confirmed.add(step.id);
        if (step.id === "deposit" || (step.id === "create-configured" && amount > 0n)) {
          deposited = true;
          setConfirmedDeposit({ owner, hash });
          if (mode === "add-more") {
            setAddMore("");
            break; // one deposit per click, never more
          }
        }
      }
    } catch (err) {
      setRunError(isRpcTrouble(err) ? RPC_TROUBLE_MESSAGE : describeTxError(err, { usdgDecimals: decimals }));
    } finally {
      setRunning(null);
      await queryClient.invalidateQueries();
    }
  }

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <p className="eyebrow">Get started</p>
          <h1 className="title">Five steps to your own vault</h1>
          <p className="meta">Each step is checked against the chain, not remembered by this page, so it&apos;s right on any device.</p>
        </div>
        <output className="progress" data-complete={summary.complete || undefined}>
          <span className="ui">{summary.text}</span>
          {!summary.complete && <span className="meta">{summary.done} of 5 done</span>}
        </output>
      </div>
      {q.error && (
        <Notice tone={isRpcTrouble(q.error) ? "guard" : "fail"} title={isRpcTrouble(q.error) ? RPC_TROUBLE_MESSAGE : "Couldn't read your wallet's state"}>
          {isRpcTrouble(q.error) ? "The steps below fill in on their own as soon as it answers." : (q.error as Error).message}
        </Notice>
      )}

      <ol className="steps">
        <Step n={1} title="Connect your wallet" status={statuses.connect}>
          <p className="meta">A browser wallet: MetaMask, Rabby, Brave Wallet or Coinbase Wallet. Glance never holds your key.</p>
          {!isConnected && (
            <button className="btn btn-primary" onClick={gate.onConnect}>
              Connect wallet
            </button>
          )}
          {address && <p className="meta mono">{address}</p>}
        </Step>

        <Step n={2} title="Add Robinhood Chain testnet" status={statuses.network}>
          <p className="meta">Chain 46630. One click adds it to your wallet if it&apos;s missing and switches to it.</p>
          {isConnected && !onChain && (
            <button className="btn btn-primary" onClick={gate.onSwitchNetwork} disabled={gate.switching}>
              {gate.switching ? "Check your wallet…" : "Add and switch"}
            </button>
          )}
        </Step>

        <Step n={3} title="Get test ETH and USDG" status={statuses.funds}>
          <ul className="checks">
            <Check ok={Boolean(s && s.eth > 0n)}>
              Test ETH for gas:{" "}
              <a href="https://faucet.testnet.chain.robinhood.com" target="_blank" rel="noreferrer">
                faucet.testnet.chain.robinhood.com ↗
              </a>
            </Check>
            <Check ok={Boolean(s && (s.usdg[effective.key] > 0n || s.snapshot.vaultUsdgBalance > 0n))}>
              {effective.key === "paxos" ? (
                <>
                  Paxos USDG:{" "}
                  <a href="https://faucet.paxos.com/" target="_blank" rel="noreferrer">
                    faucet.paxos.com ↗
                  </a>{" "}
                  (choose Robinhood Chain testnet)
                </>
              ) : (
                "TestUSDG: step 4 takes it from its on-chain faucet for you"
              )}
              {s && s.usdg[effective.key] > 0n && (
                <span className="meta mono"> · your wallet holds {formatUsd(s.usdg[effective.key], s.usdgDecimals[effective.key])}</span>
              )}
            </Check>
          </ul>
        </Step>

        <Step n={4} title="Create your vault and fund it" status={statuses.vault}>
          <VaultStep
            status={statuses.vault}
            progress={vaultProgress(inputs)}
            plan={plan}
            ready={isConnected && onChain && Boolean(s)}
            busy={busy}
            flavour={effective}
            flavours={demoVaults}
            flavourLocked={Boolean(s?.vaultFlavour)}
            onFlavour={setFlavourKey}
            vault={s?.snapshot.vault ?? null}
            vaultHref={s?.snapshot.vault ? href("/", s.snapshot.vault) : undefined}
            vaultBalance={s?.snapshot.vaultUsdgBalance ?? 0n}
            decimals={decimals}
            depositHash={depositHash}
            deposit={{ value: deposit, error: first.error ?? (first.raw === 0n && !s?.snapshot.vaultUsdgBalance ? "Enter an amount above zero." : null), onChange: setDeposit }}
            addMore={{ value: addMore, error: more.error, plan: morePlan, onChange: setAddMore, onSubmit: () => run("add-more", more.raw) }}
            onFinish={() => run("setup", first.raw)}
            runError={runError}
          />
          <TxStatus state={tx.state} />
        </Step>

        <Step n={5} title="Install the Glance extension" status={statuses.extension}>
          <p className="meta">
            Build it with <code>pnpm --filter extension build</code> and load <code>apps/extension/.output/chrome-mv3</code> as an unpacked extension (Brave, Arc,
            Chrome). In its settings, paste your vault&apos;s address. Then tap Option + G on any article.
          </p>
          <p className="meta">{extension ? "Detected on this page." : "Not detected on this page yet. (The extension marks the console when it's installed; this step isn't on chain.)"}</p>
        </Step>
      </ol>
    </div>
  );
}

const STATUS_CHIP: Record<StepStatus, string> = {
  "not-started": "chip",
  "in-progress": "chip",
  "waiting-wallet": "chip chip-guard",
  confirming: "chip chip-guard",
  done: "chip chip-accent",
  failed: "chip chip-fail",
};

function Step({ n, title, status, children }: { n: number; title: string; status: StepStatus; children: ReactNode }) {
  const done = status === "done";
  return (
    <li className="step" data-done={done || undefined} data-status={status}>
      <span className="step-n" aria-hidden>
        {done ? "✓" : n}
      </span>
      <div className="step-body">
        <div className="between">
          <h2 className="heading">{title}</h2>
          <span className={STATUS_CHIP[status]}>{STATUS_LABELS[status]}</span>
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

/** The Glance extension marks the console page when it's installed (it looks for the glance-console meta tag). */
function useExtensionInstalled(): boolean {
  const [installed, setInstalled] = useState(false);
  useEffect(() => {
    const el = document.documentElement;
    const check = () => setInstalled(el.dataset.glanceExtension === "installed");
    const obs = new MutationObserver(check);
    obs.observe(el, { attributes: true, attributeFilter: ["data-glance-extension"] });
    const id = setTimeout(check, 0);
    return () => {
      obs.disconnect();
      clearTimeout(id);
    };
  }, []);
  return installed;
}
