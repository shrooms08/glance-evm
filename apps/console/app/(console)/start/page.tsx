"use client";
import { isRpcTrouble, RPC_TROUBLE_MESSAGE } from "@glance/core/rpc";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Address, Hex } from "viem";
import { useAccount, useSignTypedData } from "wagmi";

import { Notice } from "@/components/Notice";
import { TxStatus } from "@/components/TxStatus";
import { useGate, useReconnect } from "@/components/useGate";
import { VaultStep } from "@/components/VaultStep";
import { CHAIN_ID, demoVaults, primaryVault, type DemoVault } from "@/lib/deployment";
import { parseDecimal } from "@/lib/format";
import { SingleFlight } from "@/lib/singleFlight";
import { addMorePlan, setupFlavourKey, setupPlan } from "@/lib/setup";
import { reportError } from "@/lib/report";
import { runSetupSteps } from "@/lib/setupRunner";
import { activityFor, STATUS_LABELS, stepStatuses, summarize, vaultProgress, type StepStatus, type StatusInputs } from "@/lib/setupStatus";
import { describeTxError } from "@/lib/txMessages";
import { useOwnerTx } from "@/lib/useOwnerTx";
import { readStartState, useStartState } from "@/lib/useSetupSnapshot";
import { useDevMode, useHref } from "@/lib/vault";
import { useGlanceExtension } from "@/lib/glanceExtension";
import { linkAndTell } from "@/lib/linkGlance";
import { api } from "@/lib/api";
import { GlanceStep } from "@/components/GlanceStep";
import { FundingStep, PAXOS_FAUCET, PUBLIC_GAS_FAUCET, type FundSource, type SendState } from "@/components/FundingStep";
import { nextAutoAction, promptPlan, type AutoAction, type AutoState } from "@/lib/autoSetup";
import { withGlanceAgent } from "@/lib/glanceAgent";
import { useGlanceAgent } from "@/lib/vault";

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
  const reconnect = useReconnect();
  // Paxos USDG for everyone. The TestUSDG setup is a developer fallback, reachable only with ?dev=1.
  const dev = useDevMode();
  const [chosenKey, setFlavourKey] = useState<DemoVault["key"]>(primaryVault.key);
  const flavourKey = setupFlavourKey(dev, chosenKey);
  // The agent a new vault authorises: the one the Glance API trades from now (its key may have been rotated).
  const apiAgent = useGlanceAgent();
  const flavour = withGlanceAgent(demoVaults.find((d) => d.key === flavourKey)!, apiAgent);
  const q = useStartState(address, flavour);
  const ext = useGlanceExtension();
  const hello = ext.state.status === "present" ? ext.state.hello : null;
  const onChain = chainId === CHAIN_ID;
  const s = q.data;
  const effective = withGlanceAgent(s?.vaultFlavour ?? flavour, apiAgent);
  const decimals = s?.usdgDecimals[effective.key] ?? 6;
  const tx = useOwnerTx(decimals);
  const queryClient = useQueryClient();
  const href = useHref();

  // Step 5: is Glance in this browser linked to this wallet's vault (the API's word)?
  const myVault = s?.snapshot.vault ?? null;
  const glanceLink = useQuery({
    queryKey: ["glance-link", myVault, hello?.sessionAddress],
    queryFn: () => api.sessionStatus(myVault!, hello!.sessionAddress),
    enabled: Boolean(myVault && hello),
  });
  const glanceLinked = glanceLink.data?.linked ? glanceLink.data.expiresAt : null;
  const { signTypedDataAsync } = useSignTypedData();
  const [linking, setLinking] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);

  /**
   * One signature links Glance in this browser to the wallet's own vault (the API checks the signer is its owner on
   * chain), then tells Glance which vault to use: nothing to paste.
   */
  async function connectGlance(vault: Address) {
    if (!hello) return;
    setLinking(true);
    setLinkError(null);
    try {
      await linkAndTell({
        vault,
        session: hello.sessionAddress,
        sign: ((t: Parameters<typeof signTypedDataAsync>[0]) => signTypedDataAsync(t)) as never,
        // This is the connected wallet's own vault (found by its owner), on the right network.
        ownerVerified: gate.reason === null,
        tell: ext,
      });
      await queryClient.invalidateQueries({ queryKey: ["glance-link"] });
    } catch (err) {
      reportError("Connect Glance", err);
      setLinkError((err as Error).message.split("\n")[0] ?? "Glance wasn't connected.");
    } finally {
      setLinking(false);
    }
  }

  // Step 3: gas and starter USDG from the starter fund, sent by themselves (the faucet sites when it's off or empty).
  const faucet = useQuery({ queryKey: ["faucet"], queryFn: () => api.faucet(), staleTime: 30_000 });
  const source = {
    gas: (!faucet.data?.enabled ? "off" : faucet.data.stocked.gas ? "on" : "empty") as FundSource,
    usdg: (!faucet.data?.usdg.enabled ? "off" : faucet.data.stocked.usdg ? "on" : "empty") as FundSource,
  };
  const [gas, setGas] = useState<SendState>({ state: "idle" });
  const [usdg, setUsdg] = useState<SendState>({ state: "idle" });
  async function getGas() {
    if (!address) return;
    setGas({ state: "sending" });
    try {
      const res = await api.faucetGas(address);
      setGas({ state: "sent", txHash: res.txHash });
    } catch (err) {
      setGas({ state: "failed", message: (err as Error).message });
    }
  }
  async function getUsdg() {
    if (!address) return;
    setUsdg({ state: "sending" });
    try {
      const res = await api.faucetUsdg(address);
      setUsdg({ state: "sent", txHash: res.txHash });
    } catch (err) {
      setUsdg({ state: "failed", message: (err as Error).message });
    }
  }

  // The first deposit: 20 USDG by default (what the starter fund sends), editable.
  const [deposit, setDeposit] = useState("20");
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

  // What's in flight, and for which step: "Confirming" only once a transaction hash exists (see activityFor).
  const activity = activityFor({ switching: gate.switching, running, lastMode, tx: tx.state, runError });

  const inputs: StatusInputs = {
    connected: isConnected,
    onChain,
    chain: s ? { eth: s.eth, walletUsdg: s.usdg[effective.key], snapshot: s.snapshot, flavour: effective, usdgDecimals: decimals } : undefined,
    depositConfirmed,
    extension: glanceLinked !== null,
    activity,
  };
  const statuses = stepStatuses(inputs);
  const summary = summarize(statuses);
  const busy = running !== null || tx.busy;

  // ---- "Set me up": every step starts by itself; the user only answers wallet prompts (lib/autoSetup.ts) ---------
  const tried = useRef(new Set<AutoAction>());
  const vaultReady = statuses.vault === "done";
  const auto: AutoState = {
    connected: isConnected,
    onChain,
    eth: s ? s.eth : null,
    walletUsdg: s ? s.usdg[effective.key] : null,
    usdgDecimals: decimals,
    deposit: first.raw,
    vaultReady,
    glancePresent: Boolean(hello),
    linked: glanceLinked !== null,
    faucet: { gas: source.gas === "on", usdg: source.usdg === "on" },
    busy: busy || linking || gate.switching || gas.state === "sending" || usdg.state === "sending" || effective.key !== "paxos",
    tried: tried.current,
  };
  const next = nextAutoAction(auto);
  useEffect(() => {
    if (!next) return;
    tried.current.add(next);
    if (next === "switch-network") gate.onSwitchNetwork();
    else if (next === "get-gas") void getGas();
    else if (next === "get-usdg") void getUsdg();
    else if (next === "create") run("setup", first.raw);
    else if (next === "link" && myVault) void connectGlance(myVault);
    // Each action runs once per visit; `next` changes only when the state it depends on does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [next]);
  const plannedPrompts = promptPlan({
    connected: isConnected,
    onChain,
    vaultReady,
    approveNeeded: !plan || plan.steps.some((st) => /^Approve/.test(st.label)),
    glancePresent: Boolean(hello),
    linked: glanceLinked !== null,
  });

  // Glance's setup card follows along (display only: Glance checks readiness itself, with the API).
  const progressKey = `${isConnected}|${Boolean(myVault)}|${vaultReady}|${glanceLinked !== null}`;
  useEffect(() => {
    if (hello) ext.progress({ wallet: isConnected, vault: Boolean(myVault), funded: vaultReady, linked: glanceLinked !== null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [progressKey, Boolean(hello)]);

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
    try {
      const outcome = await runSetupSteps({
        mode,
        createDeposits: amount > 0n,
        read: async () => {
          const fresh = await readStartState(owner, flavour);
          const f = withGlanceAgent(fresh.vaultFlavour ?? flavour, apiAgent);
          const dec = fresh.usdgDecimals[f.key];
          return {
            snapshot: fresh.snapshot,
            plan: (deposited) =>
              mode === "setup"
                ? setupPlan(fresh.snapshot, f, dec, amount, deposited || depositConfirmed)
                : addMorePlan(fresh.snapshot, f, dec, amount),
          };
        },
        send: (step, target, args) => tx.send({ label: step.label, address: target, abi: step.call.abi, functionName: step.call.functionName, args }),
        onDeposited: (hash) => {
          setConfirmedDeposit({ owner, hash });
          if (mode === "add-more") setAddMore("");
        },
      });
      // Glance is in this browser: creating the vault goes straight on to linking it (one signature, the last prompt).
      if (outcome.kind === "done" && mode === "setup" && hello && !glanceLinked) {
        const fresh = await readStartState(owner, flavour);
        if (fresh.snapshot.vault) await connectGlance(fresh.snapshot.vault);
      }
      // Every ending but "done" is shown; a failed transaction already shows its own reason in TxStatus.
      if (outcome.kind === "blocked" || outcome.kind === "stopped") {
        reportError(`Get started (${mode}): ${outcome.kind}`, new Error(outcome.reason));
        setRunError(outcome.reason);
      }
    } catch (err) {
      reportError(`Get started (${mode})`, err);
      setRunError(isRpcTrouble(err) ? RPC_TROUBLE_MESSAGE : describeTxError(err, { usdgDecimals: decimals, account: owner }));
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
          <p className="meta">Each step starts by itself once the one before is done; you only answer your wallet. Every step is checked against the chain, so it&apos;s right on any device.</p>
          <p className="ui">The plan: {plannedPrompts}.</p>
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
          {isConnected && !onChain && gate.switchError && <p className="meta text-fail">{gate.switchError}</p>}
        </Step>

        <Step n={3} title="Get test ETH and USDG" status={statuses.funds}>
          <FundingStep
            hasEth={Boolean(s && s.eth > 0n)}
            hasUsdg={Boolean(s && (s.usdg[effective.key] > 0n || s.snapshot.vaultUsdgBalance > 0n))}
            usdgKey={effective.key === "paxos" ? "paxos" : "test"}
            walletUsdg={s?.usdg[effective.key] ?? 0n}
            usdgDecimals={decimals}
            source={source}
            connected={isConnected}
            gas={gas}
            usdg={usdg}
            onGetGas={() => void getGas()}
            onGetUsdg={() => void getUsdg()}
          />
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
            showFlavourChoice={dev && !s?.vaultFlavour}
            onFlavour={setFlavourKey}
            vault={s?.snapshot.vault ?? null}
            vaultHref={s?.snapshot.vault ? href("/dashboard", s.snapshot.vault) : undefined}
            vaultBalance={s?.snapshot.vaultUsdgBalance ?? 0n}
            decimals={decimals}
            depositHash={depositHash}
            deposit={{ value: deposit, error: first.error ?? (first.raw === 0n && !s?.snapshot.vaultUsdgBalance ? "Enter an amount above zero." : null), onChange: setDeposit }}
            addMore={{ value: addMore, error: more.error, plan: morePlan, onChange: setAddMore, onSubmit: () => run("add-more", more.raw) }}
            onFinish={() => run("setup", first.raw)}
            runError={runError}
            linkAfter={Boolean(hello) && !glanceLinked && !s?.snapshot.vault}
            onErrorAction={(kind) => {
              if (kind === "get-gas") return source.gas === "on" ? void getGas() : void window.open(PUBLIC_GAS_FAUCET, "_blank", "noopener");
              if (kind === "get-usdg") return source.usdg === "on" ? void getUsdg() : void window.open(PAXOS_FAUCET, "_blank", "noopener");
              if (kind === "switch-network") return gate.onSwitchNetwork();
              run("setup", first.raw);
            }}
          />
          <TxStatus state={tx.state} onReconnect={() => void reconnect()} />
        </Step>

        <Step n={5} title="Connect Glance to your vault" status={statuses.extension}>
          <GlanceStep
            ext={ext.state.status}
            vault={myVault}
            linkedUntil={glanceLinked}
            busy={linking || busy}
            ready={gate.reason === null}
            error={linkError}
            onConnect={() => myVault && void connectGlance(myVault)}
          />
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
