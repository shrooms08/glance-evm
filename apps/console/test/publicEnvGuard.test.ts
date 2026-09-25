/** The console's build refuses public variables that would ship a secret to every visitor (names only in the error). */
import { describe, expect, it } from "vitest";

import { assertPublicEnvSafe, publicEnvProblems } from "../publicEnvGuard";

// Made-up credentials, built at runtime: never real, never key-shaped in the source.
const TOKEN = "t".repeat(8) + "0".repeat(24);

describe("public variables", () => {
  it("the safe ones build: the API URL, the public RPC, the explorer, the WalletConnect project id", () => {
    expect(
      publicEnvProblems({
        NEXT_PUBLIC_GLANCE_API_URL: "https://glance-api.up.railway.app",
        NEXT_PUBLIC_RPC_URL: "https://rpc.testnet.chain.robinhood.com",
        NEXT_PUBLIC_EXPLORER_URL: "https://explorer.testnet.chain.robinhood.com",
        NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID: "0".repeat(32),
        NEXT_PUBLIC_RPC_FALLBACK_URLS: "",
      }),
    ).toEqual([]);
  });

  it.each([
    ["a QuickNode token path", `https://some-name.robinhood-testnet.quiknode.pro/${TOKEN}/`],
    ["an Alchemy key path", `https://robinhood-testnet.g.alchemy.com/v2/${TOKEN}`],
    ["an Infura project id", `https://mainnet.infura.io/v3/${"ab".repeat(16)}`],
    ["a key query parameter", `https://rpc.example.com/?apikey=${TOKEN}`],
    ["user:password", "https://user:pass@rpc.example.com"],
  ])("an RPC URL with %s is refused, and the error names only the variable", (_what, url) => {
    expect(publicEnvProblems({ NEXT_PUBLIC_RPC_URL: url })).toEqual(["NEXT_PUBLIC_RPC_URL contains an RPC URL with a key in it"]);
    let message = "";
    try {
      assertPublicEnvSafe({ NEXT_PUBLIC_RPC_FALLBACK_URLS: `https://rpc.testnet.chain.robinhood.com,${url}` });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/^Refusing to build/);
    expect(message).toContain("NEXT_PUBLIC_RPC_FALLBACK_URLS");
    expect(message).not.toContain(TOKEN);
  });

  it("a public variable named like a secret is refused", () => {
    expect(publicEnvProblems({ NEXT_PUBLIC_ANTHROPIC_API_KEY: "x", NEXT_PUBLIC_ADMIN_TOKEN: "y" })).toEqual([
      "NEXT_PUBLIC_ANTHROPIC_API_KEY is named like a secret",
      "NEXT_PUBLIC_ADMIN_TOKEN is named like a secret",
    ]);
  });
});
