import { defineConfig } from "wxt";

/**
 * Manifest V3 for Chrome, Brave and Edge.
 * The fixed `key` gives every install the same extension ID (gmcdcaoneeohbacbnafjdnkkoojgnogl), from any folder, any
 * profile, and the judges' zip: the ID is a hash of this key, not of the folder. So CORS_ORIGINS names it once, and
 * the browser's microphone grant (kept per extension origin) survives rebuilds. It is the PUBLIC key only; the private
 * key lives outside the repository (~/.glance-extension-key.pem, for packing a .crx) and is never committed.
 */
export default defineConfig({
  modules: ["@wxt-dev/module-react"],
  manifestVersion: 3,
  // The end-to-end check builds into its own folder, so it never replaces the build loaded in your browser.
  outDir: process.env.WXT_OUT_DIR || ".output",
  zip: { name: "glance-extension", artifactTemplate: "{{name}}-{{version}}.zip" },
  manifest: {
    name: "Glance",
    short_name: "Glance",
    description: "Buy tokenized stocks from any page, through an agent your vault keeps on a leash.",
    key: "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAzSKiRVmB29xrSL3ltvB7VAxQqYI8vkiwzSVmL/lwl1SlR8kC37I2XNaKRmmmbNvbIQ08isueZYCX9ZoPhAaaVg2PEcOmMFzO8MKr59voqpNXU0uY2P7WcgydVtv77QQ5QL12qMJ0qULmJszw8zxQKEZV3TJNc1yUidCVWdBldaD1cJU3Q8jICvxmpJfdf+jyp+LyXl91Fa0xl8rbRas57CKVBRgK5p3jHES61QE9DjTZZJJL83NauLUYFe350OykV0j1UUizqbNYkiq5IzQKfxWlPWsFLw8Wo7I58skKcokuu0DiGNl4yWZeIzzb3PQ6mAsh9Bt7MAmskRwcG9MC0wIDAQAB",
    minimum_chrome_version: "116",
    permissions: ["storage", "sidePanel", "offscreen"],
    host_permissions: ["http://localhost/*", "http://127.0.0.1/*"],
    optional_host_permissions: ["https://*/*", "http://*/*"],
    action: { default_title: "Open Glance in the side panel" },
    // ⌥G is a browser command (changeable in the browser's keyboard shortcuts for extensions): one press, and it grants
    // activeTab, so Show me can take its screenshot of the page. Talk has NO default key on purpose: a command sees no
    // key release, and ⌥V is hold to speak, release to send, handled on the page itself. Assign talk a key there only
    // if you prefer press to start, press again to send.
    commands: {
      glance: { suggested_key: { default: "Alt+G", mac: "Alt+G" }, description: "Glance at this page" },
      talk: { description: "Talk to Glance: press to start, press again to send (⌥V held on the page works without this)" },
    },
    icons: { 16: "icon/16.png", 32: "icon/32.png", 48: "icon/48.png", 128: "icon/128.png" },
    // chart-mount.js: the floating panel's chart, loaded by the content script on first use.
    web_accessible_resources: [{ resources: ["fonts/*", "glance-mark.png", "sfx/*", "chart-mount.js"], matches: ["<all_urls>"] }],
  },
});
