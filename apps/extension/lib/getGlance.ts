/**
 * Where to get Glance (it isn't in a store yet): the console serves the latest zip at a stable path, and its
 * "Get Glance" page has the install steps. The extension's own "Get Glance" links point at the console it was built
 * for (the hosted one in a production build).
 */
export const LATEST_ZIP_PATH = "/downloads/glance-extension-latest.zip";

const base = (consoleUrl: string) => consoleUrl.replace(/\/+$/, "");

export const latestZipUrl = (consoleUrl: string) => `${base(consoleUrl)}${LATEST_ZIP_PATH}`;
export const installPageUrl = (consoleUrl: string) => `${base(consoleUrl)}/install`;
