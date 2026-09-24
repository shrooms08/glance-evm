/**
 * Glance needs your own vault: there's no built-in vault and no demo fallback. The vault starts empty, and only the
 * console's handshake (or a developer, under Settings > Advanced) sets it.
 */
import { fakeBrowser } from "wxt/testing/fake-browser";
import { beforeEach, describe, expect, it } from "vitest";

import * as settings from "../lib/settings";

beforeEach(() => fakeBrowser.reset());

describe("no demo vault", () => {
  it("the vault is empty until the console sets it", async () => {
    expect(await settings.vaultAddress.getValue()).toBe("");
    expect(await settings.vaultSource.getValue()).toBeNull();
  });

  it("nothing demo is left in the settings module", () => {
    expect(Object.keys(settings).filter((k) => /demo|default_vault/i.test(k))).toEqual([]);
  });
});
