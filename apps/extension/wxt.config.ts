import { defineConfig } from "wxt";

/**
 * Manifest V3 for Chrome, Brave and Edge.
 * The fixed `key` gives every unpacked install the same extension ID (ldkhnhnmgilpmpdacnfajmilandbalfj), so it can be
 * added to the API's CORS_ORIGINS once. It is a public key; the matching private key was never kept.
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
    key: "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA8yV3dhUWeWn7kvet4GWLKKvLbezbAXKnLJo4UTJQTMj78BysrEdVGDA/LsQS7j/daej3786Tg2wSUAc1folpeB/aG1qzA6pDtzzAp+bSamyzr2206el64Xbb87e6p+pm5jx7/GuaX+/inBooDGRsr2MVZRnNqV6cfMo5yPa41RghVteGq+EAboDD4XSmX5N/ej+3+gAhYGebSJ7RNtcdQ0ONnSFHjIET/D2KcPYShOuTAq7pcrkBu7VloNh5/uEzchOe21cXQ2id1Xmj4Sozyv1sbh4F3wxLQ/jWCotFPyp2VdkbPHTitDaQOiUl7rQfRH3tXNUNc/eHKCRtioTDoQIDAQAB",
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
