/**
 * Real-browser render pass for chat-native connector setup and background
 * picker widgets. Bundles the fixture with the real chat renderer and targeted
 * shell/runtime shims, captures desktop + mobile screenshots, and writes
 * text/color heuristics for PR review.
 *
 * Run: bun run --cwd packages/ui test:connector-background-e2e
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { PNG } from "pngjs";
import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../../../../../..");
const outDir = join(here, "output-connector-background");
await mkdir(outDir, { recursive: true });

let failures = 0;
function assert(condition, message) {
  console.log(`${condition ? "[ok]" : "[fail]"} ${message}`);
  if (!condition) failures += 1;
}

const apiStub = join(outDir, "api-stub.ts");
const stateStub = join(outDir, "state-stub.ts");
const sharedStub = join(outDir, "shared-stub.ts");
const connectorAccountOptionsStub = join(
  outDir,
  "connector-account-options-stub.ts",
);
const eventsStub = join(outDir, "events-stub.ts");
const platformStub = join(outDir, "platform-stub.ts");
const mobilePermissionsStub = join(outDir, "mobile-permissions-stub.ts");
const remoteFirstRunStub = join(outDir, "remote-first-run-stub.ts");
const inlineBuiltinsStub = join(outDir, "inline-builtins-stub.tsx");
const loggerStub = join(outDir, "logger-stub.ts");
const agentSurfaceStub = join(outDir, "agent-surface-stub.ts");
const messageAttachmentsStub = join(outDir, "message-attachments-stub.tsx");
const permissionRenderStub = join(outDir, "permission-render-stub.tsx");
const assetUrlStub = join(outDir, "asset-url-stub.ts");
const slashMenuStub = join(outDir, "slash-menu-stub.ts");
const chatComposerStub = join(outDir, "chat-composer-stub.ts");
const imageAttachmentStub = join(outDir, "image-attachment-stub.ts");
const mobileRuntimeModeStub = join(outDir, "mobile-runtime-mode-stub.ts");
const csrfClientStub = join(outDir, "csrf-client-stub.ts");
await writeFile(
  apiStub,
  `const TELEGRAM_PLUGIN = {
  id: "telegram",
  name: "Telegram",
  description: "Telegram bot connector",
  enabled: false,
  configured: false,
  envKey: null,
  category: "connector",
  source: "bundled",
  icon: "T",
  parameters: [
    {
      key: "TELEGRAM_BOT_TOKEN",
      type: "string",
      description: "Bot token from @BotFather",
      required: true,
      sensitive: true,
      currentValue: null,
      isSet: false,
    },
    {
      key: "TELEGRAM_API_ROOT",
      type: "string",
      description: "API root override",
      required: false,
      sensitive: false,
      currentValue: null,
      isSet: false,
    },
    {
      key: "TELEGRAM_ALLOWED_CHATS",
      type: "string",
      description: "Comma-separated chat allowlist",
      required: false,
      sensitive: false,
      currentValue: null,
      isSet: false,
    },
  ],
  validationErrors: [],
  validationWarnings: [],
};
export const client = {
  getPlugins: async () => ({ plugins: [TELEGRAM_PLUGIN] }),
  updatePlugin: async () => ({ success: true }),
  startConnectorAccountOAuth: async () => ({ ok: true, authUrl: "https://telegram.org/oauth/mock" }),
  authorizeDiscordLocal: async () => ({ ok: true }),
  uploadBackgroundImage: async () => ({ url: "/api/media/mock-background.png" }),
  generateBackgroundImage: async () => ({ url: "/api/media/generated-background.png" }),
  getPermission: async (id) => ({ id, status: "not-determined", lastChecked: 0, canRequest: true, platform: "darwin" }),
  requestPermission: async (id) => ({ id, status: "granted", lastChecked: Date.now(), canRequest: true, platform: "darwin" }),
  openPermissionSettings: async () => true,
};
`,
);
await writeFile(
  stateStub,
  `const DICT = {
  "common.save": "Save",
  "common.saved": "Saved",
  "common.saving": "Saving",
  "common.disable": "Disable",
  "secretsview.Required": "Required",
};
const t = (key, vars = {}) => {
  const template = String(vars.defaultValue ?? DICT[key] ?? key);
  return template.replace(/\\{\\{(\\w+)\\}\\}/g, (whole, name) =>
    Object.hasOwn(vars, name) ? String(vars[name]) : whole
  );
};
const appValue = {
  t,
  elizaCloudConnected: true,
  setActionNotice: () => {},
  loadPlugins: async () => {},
};
export function useAppSelector(selector) {
  return selector(appValue);
}
export function useAppSelectorShallow(selector) {
  return selector(appValue);
}
export function useTranslation() {
  return { t, uiLanguage: "en", setUiLanguage: () => {} };
}
`,
);
await writeFile(
  sharedStub,
  `export const DEFAULT_DESKTOP_API_PORT = 2138;
export const CHAT_IMAGE_MIME_TYPE_SET = new Set(["image/png", "image/jpeg", "image/webp"]);
export const CHAT_UPLOAD_MIME_TYPE_SET = new Set(["image/png", "image/jpeg", "image/webp"]);
export const MAX_CHAT_ATTACHMENT_NAME_LENGTH = 160;
export const MAX_CHAT_IMAGE_BASE64_BYTES = 4 * 1024 * 1024;
export const MAX_CHAT_MEDIA_RAW_BYTES = 20 * 1024 * 1024;
export const MAX_CHAT_UPLOAD_ATTACHMENTS = 4;
export const ENV_KEY_ACRONYMS = new Set(["API", "URL", "ID"]);
export function autoLabel(key) {
  return String(key ?? "")
    .replace(/^[A-Z0-9]+_/, "")
    .replace(/_/g, " ")
    .toLowerCase()
    .replace(/\\b\\w/g, (m) => m.toUpperCase());
}
export function stripAssistantStageDirections(text) {
  return text;
}
export function isPermissionId(value) {
  return typeof value === "string" && value.length > 0;
}
export function openPermissionSettings() {
  return false;
}
`,
);
await writeFile(
  connectorAccountOptionsStub,
  `export const CONNECTOR_PLUGIN_MANAGED_MODE_ID = "plugin-managed";
export function normalizeConnectorCatalogId(id) {
  return String(id ?? "").replace(/^@elizaos\\/plugin-/, "").replace(/^plugin-/, "");
}
`,
);
await writeFile(
  eventsStub,
  `export const BRIDGE_READY_EVENT = "eliza:bridge-ready";
export const CONNECT_EVENT = "eliza:connect";
export const MOBILE_RUNTIME_MODE_CHANGED_EVENT = "eliza:mobile-runtime-mode-changed";
export function dispatchAppEvent(name, detail) {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(name, { detail }));
  }
}
export function dispatchNavigateViewEvent(detail) {
  dispatchAppEvent("eliza:navigate:view", detail);
}
`,
);
await writeFile(
  platformStub,
  `export function isDesktopPlatform() {
  return false;
}
export function isNative() {
  return false;
}
`,
);
await writeFile(
  mobilePermissionsStub,
  `export function createMobileSignalsPermissionsRegistry() {
  return null;
}
export function openMobilePermissionSettings() {
  return false;
}
`,
);
await writeFile(
  remoteFirstRunStub,
  `export function normalizeRemoteAgentUrl(value) {
  return new URL(value).toString().replace(/\\/+$/, "");
}
`,
);
await writeFile(
  inlineBuiltinsStub,
  `import { findBackgroundRegions } from ${JSON.stringify(join(repoRoot, "packages/ui/src/components/chat/message-background-parser.ts"))};
import { BackgroundWidget } from ${JSON.stringify(join(repoRoot, "packages/ui/src/components/chat/widgets/background-widget.tsx"))};
import { registerInlineWidget } from ${JSON.stringify(join(repoRoot, "packages/ui/src/components/chat/widgets/inline-registry.tsx"))};

registerInlineWidget({
  kind: "background",
  parse: (text) => findBackgroundRegions(text).map((match) => ({ ...match, data: match })),
  keyFor: (match) => \`background:\${match.start}\`,
  render: (_match, _ctx, key) => <BackgroundWidget key={key} />,
});
`,
);
await writeFile(
  loggerStub,
  `export const logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};
`,
);
await writeFile(
  agentSurfaceStub,
  `export function useAgentElement() {
  return { ref: null, agentProps: {} };
}
`,
);
await writeFile(
  messageAttachmentsStub,
  `export function MessageAttachments() {
  return null;
}
`,
);
await writeFile(
  permissionRenderStub,
  `export function renderPermissionCardFromPayload() {
  return null;
}
`,
);
await writeFile(
  assetUrlStub,
  `export function resolveApiUrl(path) {
  return path;
}
export function resolveAppAssetUrl(path) {
  return path;
}
`,
);
await writeFile(
  slashMenuStub,
  `export function splitLeadingSlashCommand(text) {
  const match = /^(\\/[\\w-]+)(?=\\s|$)/.exec(text);
  return match ? { command: match[1], rest: text.slice(match[1].length) } : null;
}
`,
);
await writeFile(
  chatComposerStub,
  `export function useChatComposer() {
  return {
    chatInput: "",
    chatSending: false,
    chatPendingImages: [],
    setChatInput: () => {},
    setChatPendingImages: () => {},
  };
}
`,
);
await writeFile(
  imageAttachmentStub,
  `export const MAX_CHAT_IMAGES = 4;
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_ATTACHMENTS_TOTAL_BYTES = 60 * 1024 * 1024;
export const CHAT_UPLOAD_ACCEPT = "image/*";
export function bytesToMb(bytes) {
  return Math.round(bytes / (1024 * 1024));
}
export function perFileByteCap() {
  return MAX_ATTACHMENT_BYTES;
}
export function partitionAttachmentFiles(files) {
  return { accepted: Array.from(files), droppedTooLarge: [], droppedOverCount: [] };
}
export async function filesToImageAttachments() {
  return [];
}
`,
);
await writeFile(
  mobileRuntimeModeStub,
  `export const MOBILE_RUNTIME_MODE_STORAGE_KEY = "eliza:mobile-runtime-mode";
export const MOBILE_LOCAL_AGENT_API_BASE = "http://127.0.0.1:2138";
export const MOBILE_LOCAL_AGENT_IPC_BASE = "eliza-local://agent";
export function readPersistedMobileRuntimeMode() {
  return null;
}
export function isMobileLocalAgentIpcUrl() {
  return false;
}
export function isMobileLocalAgentIpcBase() {
  return false;
}
export function isMobileLocalAgentUrl() {
  return false;
}
export function isElizaCloudRuntimeLocked() {
  return false;
}
`,
);
await writeFile(
  csrfClientStub,
  `export async function fetchWithCsrf(input, init) {
  return fetch(input, init);
}
`,
);

const result = await build({
  entryPoints: [join(here, "connector-background-fixture.tsx")],
  bundle: true,
  format: "iife",
  platform: "browser",
  conditions: ["browser", "import"],
  jsx: "automatic",
  loader: { ".tsx": "tsx", ".ts": "ts" },
  define: { "process.env.NODE_ENV": '"production"' },
  logOverride: { "empty-import-meta": "silent" },
  alias: {
    "@elizaos/core": join(repoRoot, "packages/ui/stories/src/eliza-core-browser-shim.ts"),
  },
  plugins: [
    {
      name: "stub-widget-api",
      setup(builder) {
        builder.onResolve({ filter: /\/api\/client$/ }, () => ({
          path: apiStub,
        }));
        builder.onResolve({ filter: /\/api$/ }, () => ({
          path: apiStub,
        }));
        builder.onResolve({ filter: /(^|\/)state$/ }, () => ({
          path: stateStub,
        }));
        builder.onResolve({ filter: /(^|\/)app-store$/ }, () => ({
          path: stateStub,
        }));
        builder.onResolve({ filter: /inline-builtins$/ }, () => ({
          path: inlineBuiltinsStub,
        }));
        builder.onResolve({ filter: /^@elizaos\/shared$/ }, () => ({
          path: sharedStub,
        }));
        builder.onResolve({ filter: /^@elizaos\/logger$/ }, () => ({
          path: loggerStub,
        }));
        builder.onResolve(
          { filter: /^@elizaos\/shared\/utils\/asset-url$/ },
          () => ({
            path: assetUrlStub,
          }),
        );
        builder.onResolve({ filter: /\/agent-surface$/ }, () => ({
          path: agentSurfaceStub,
        }));
        builder.onResolve({ filter: /\/MessageAttachments$/ }, () => ({
          path: messageAttachmentsStub,
        }));
        builder.onResolve({ filter: /permission-card\.render$/ }, () => ({
          path: permissionRenderStub,
        }));
        builder.onResolve({ filter: /\/chat\/slash-menu$/ }, () => ({
          path: slashMenuStub,
        }));
        builder.onResolve(
          { filter: /\/state\/ChatComposerContext\.hooks$/ },
          () => ({
            path: chatComposerStub,
          }),
        );
        builder.onResolve({ filter: /\/utils\/image-attachment$/ }, () => ({
          path: imageAttachmentStub,
        }));
        builder.onResolve(
          { filter: /\/first-run\/mobile-runtime-mode$/ },
          () => ({
            path: mobileRuntimeModeStub,
          }),
        );
        builder.onResolve({ filter: /\/api\/csrf-client$/ }, () => ({
          path: csrfClientStub,
        }));
        builder.onResolve({ filter: /\/events$/ }, () => ({
          path: eventsStub,
        }));
        builder.onResolve({ filter: /\/platform$/ }, () => ({
          path: platformStub,
        }));
        builder.onResolve(
          { filter: /\/platform\/mobile-permissions-client$/ },
          () => ({
            path: mobilePermissionsStub,
          }),
        );
        builder.onResolve(
          { filter: /\/first-run\/adopt-remote-first-run$/ },
          () => ({
            path: remoteFirstRunStub,
          }),
        );
        builder.onResolve(
          { filter: /connector-account-options$/ },
          () => ({
            path: connectorAccountOptionsStub,
          }),
        );
      },
    },
  ],
  write: false,
});

const js = result.outputFiles[0].text;
const baseCss = await readFile(
  join(repoRoot, "packages/ui/src/styles/base.css"),
  "utf8",
);
const tokenCss = `
:root{color-scheme:dark;--bg:#0b0b0c;--card:#17171a;--border:#34343a;--txt:#ededed;--muted:#9aa0a6;--accent:#ef5a1f;--accent-fg:#ffffff}
html,body{margin:0;min-height:100%;background:var(--bg);font-family:Inter,ui-sans-serif,system-ui,sans-serif}
.text-txt,.text-txt-strong{color:var(--txt)}.text-muted{color:var(--muted)}.text-muted-strong{color:#c8c8cc}
.text-ok{color:#34d399}.text-warn{color:#fbbf24}.text-danger{color:#f87171}.text-accent{color:var(--accent)}.text-accent-fg{color:var(--accent-fg)}
.bg-bg{background:var(--bg)}.bg-card{background:var(--card)}.bg-bg-hover{background:#202024}.bg-bg-accent{background:#23180f}.bg-accent{background:var(--accent)}.bg-accent\\/10{background:rgba(239,90,31,.1)}.bg-accent-subtle{background:rgba(239,90,31,.18)}
.border-border{border-color:var(--border)}.border-accent{border-color:var(--accent)}
.ring-border\\/40{--tw-ring-color:rgba(52,52,58,.4)}.ring-accent{--tw-ring-color:var(--accent)}.ring-accent\\/40{--tw-ring-color:rgba(239,90,31,.4)}
`;
const html = `<!doctype html><html class="dark"><head><meta charset="utf-8"><title>connector background widgets</title>
<script src="https://cdn.tailwindcss.com"></script>
<style>${baseCss}</style><style>${tokenCss}</style></head><body><div id="root"></div><script>globalThis.process={env:{NODE_ENV:"production"}};</script><script>${js}</script></body></html>`;
const htmlPath = join(outDir, "connector-background.html");
await writeFile(htmlPath, html);

function rgbToHsl(r, g, b) {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  const l = (max + min) / 2;
  const d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s, l };
}

function colorFractions(buffer) {
  const png = PNG.sync.read(buffer);
  let sampled = 0;
  let blue = 0;
  let orange = 0;
  let neutral = 0;
  for (let y = 0; y < png.height; y += 4) {
    for (let x = 0; x < png.width; x += 4) {
      const idx = (png.width * y + x) << 2;
      const a = png.data[idx + 3];
      if (a < 32) continue;
      const { h, s, l } = rgbToHsl(png.data[idx], png.data[idx + 1], png.data[idx + 2]);
      sampled += 1;
      if (s < 0.12) neutral += 1;
      if (h >= 190 && h <= 260 && s > 0.2 && l > 0.12) blue += 1;
      if ((h <= 45 || h >= 350) && s > 0.22 && l > 0.12) orange += 1;
    }
  }
  return {
    sampled,
    blueFraction: sampled ? Number((blue / sampled).toFixed(4)) : 0,
    orangeFraction: sampled ? Number((orange / sampled).toFixed(4)) : 0,
    neutralFraction: sampled ? Number((neutral / sampled).toFixed(4)) : 0,
  };
}

function rawI18nKeys(text) {
  return [
    ...new Set(
      text.match(
        /\b(?:common|secretsview|messagecontent|config-field|config-renderer|ui-renderer)\.[A-Za-z0-9_.-]+/g,
      ) ?? [],
    ),
  ];
}

const browser = await chromium.launch();
const run = {
  generatedAt: new Date().toISOString(),
  url: `file://${htmlPath}`,
  states: [],
  consoleErrors: [],
};

try {
  const page = await browser.newPage({
    viewport: { width: 920, height: 980 },
    deviceScaleFactor: 2,
  });
  page.on("pageerror", (error) => run.consoleErrors.push(String(error)));
  page.on("console", (message) => {
    if (message.type() === "error") run.consoleErrors.push(message.text());
  });
  await page.goto(run.url);
  await page.waitForSelector('[data-testid="inline-plugin-config"]', {
    timeout: 15_000,
  });
  await page.waitForSelector('[data-testid="inline-background"]', {
    timeout: 15_000,
  });
  await page.waitForTimeout(600);

  assert(
    (await page.locator('[data-testid="inline-plugin-config-mode-cloud-bot"]').count()) === 1,
    "cloud gateway mode renders in the connector setup card",
  );
  assert(
    (await page.locator('[data-testid="inline-plugin-config-mode-bot"]').count()) === 1,
    "bot token fallback mode renders in the connector setup card",
  );
  assert(
    (await page.locator('[data-testid="inline-plugin-config-mode-account"]').count()) === 1,
    "personal account local mode renders in the connector setup card",
  );
  assert(
    (await page.locator('[data-testid="background-settings-controls"][data-variant="filmstrip"]').count()) === 1,
    "background picker renders the filmstrip controls",
  );

  for (const state of [
    { name: "desktop", width: 920, height: 980 },
    { name: "mobile", width: 390, height: 844 },
  ]) {
    await page.setViewportSize({ width: state.width, height: state.height });
    await page.waitForTimeout(300);
    const path = join(outDir, `connector-background-${state.name}.png`);
    const buffer = await page.screenshot({ path, fullPage: true });
    const text = await page.locator('[data-testid="connector-background-fixture"]').innerText();
    const untranslated = rawI18nKeys(text);
    assert(
      untranslated.length === 0,
      `${state.name} capture has no raw i18n keys${
        untranslated.length ? ` (${untranslated.join(", ")})` : ""
      }`,
    );
    const metrics = await page.evaluate(() => {
      const fixture = document.querySelector('[data-testid="connector-background-fixture"]');
      const widgets = Array.from(
        document.querySelectorAll('[data-testid="inline-plugin-config"],[data-testid="inline-background"]'),
      ).map((el) => {
        const rect = el.getBoundingClientRect();
        return {
          testid: el.getAttribute("data-testid"),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          text: (el.textContent ?? "").replace(/\s+/g, " ").trim(),
        };
      });
      return {
        viewport: { width: window.innerWidth, height: window.innerHeight },
        fixtureTextLength: (fixture?.textContent ?? "").trim().length,
        widgets,
      };
    });
    run.states.push({
      ...state,
      screenshot: path,
      text: text.replace(/\s+/g, " ").trim(),
      metrics,
      color: colorFractions(buffer),
    });
    console.log(`  screenshot: ${path}`);
  }
} finally {
  await browser.close();
}

assert(run.consoleErrors.length === 0, `no browser console/page errors (${run.consoleErrors.length})`);
await writeFile(join(outDir, "summary.json"), `${JSON.stringify(run, null, 2)}\n`);
console.log(`summary: ${join(outDir, "summary.json")}`);

if (failures > 0) {
  console.error(`\n${failures} assertion(s) FAILED`);
  process.exit(1);
}
console.log("\nAll connector/background widget assertions passed.");
