/**
 * The Glance vault factories recorded in deployments/<chain>.json: the original `factory` (create, then configure
 * with one owner transaction per setting) and, once deployed, `factoryV2` (one transaction to a configured, funded
 * vault). Both stay valid: vaults from either are ordinary GlanceVaults, and neither factory has any rights over them.
 */
export interface FactoryRecord {
  factory: { address: string };
  factoryV2?: { address: string } | null;
}

export interface GlanceFactory {
  version: 1 | 2;
  address: `0x${string}`;
}

/** Every recorded factory, oldest first. */
export function glanceFactories(record: FactoryRecord): GlanceFactory[] {
  const out: GlanceFactory[] = [{ version: 1, address: record.factory.address as `0x${string}` }];
  if (record.factoryV2?.address) out.push({ version: 2, address: record.factoryV2.address as `0x${string}` });
  return out;
}

/** The one-transaction factory, or null while it isn't deployed (callers fall back to the step-by-step setup). */
export function factoryV2Address(record: FactoryRecord): `0x${string}` | null {
  return glanceFactories(record).find((f) => f.version === 2)?.address ?? null;
}
