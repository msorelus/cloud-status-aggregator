// Build the Teams app package (manifest + icons -> cloud-status-agent.zip).
//
// Resolves the manifest template's ${{BOT_ID}} / ${{TUNNEL_HOST}} placeholders,
// strips the message-only bot's unused SSO block, and produces a sideload-ready
// zip with manifest.json + icons at the archive root.
//
// Values are taken from (in priority order):
//   1. env vars  BOT_ID / TUNNEL_HOST
//   2. the previously built appPackage/build/manifest.json (id / validDomains)
//   3. .env (clientId) for BOT_ID
// Re-run after the bot id or devtunnel host changes:  npm run package
import { execSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const appDir = join(here, "..", "appPackage");
const buildDir = join(appDir, "build");
const templatePath = join(appDir, "manifest.json");
const zipPath = join(appDir, "cloud-status-agent.zip");

function readJson(path) {
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
}

function envFromDotenv(key) {
  const dotenv = join(here, "..", ".env");
  if (!existsSync(dotenv)) return undefined;
  const line = readFileSync(dotenv, "utf8")
    .split(/\r?\n/)
    .find((l) => l.toLowerCase().startsWith(key.toLowerCase() + "="));
  return line ? line.slice(line.indexOf("=") + 1).trim() : undefined;
}

const prior = readJson(join(buildDir, "manifest.json"));
const botId = process.env.BOT_ID || prior?.id || envFromDotenv("clientId");
const tunnelHost = process.env.TUNNEL_HOST || prior?.validDomains?.[0];

if (!botId || !tunnelHost) {
  console.error(
    "Missing BOT_ID and/or TUNNEL_HOST. Set them as env vars, e.g.\n" +
      "  BOT_ID=<app-guid> TUNNEL_HOST=<your-tunnel-host>.devtunnels.ms npm run package"
  );
  process.exit(1);
}

const resolved = readFileSync(templatePath, "utf8")
  .replaceAll("${{BOT_ID}}", botId)
  .replaceAll("${{TUNNEL_HOST}}", tunnelHost);

const manifest = JSON.parse(resolved);
// Defensive: keep the package valid even if the template drifts.
delete manifest.packageName; // not allowed in manifest schema 1.17
delete manifest.webApplicationInfo; // message-only bot, no Teams SSO
if (manifest.accentColor && !manifest.accentColor.startsWith("#")) {
  manifest.accentColor = "#" + manifest.accentColor; // schema requires a leading '#'
}

mkdirSync(buildDir, { recursive: true });
writeFileSync(join(buildDir, "manifest.json"), JSON.stringify(manifest, null, 2));
for (const icon of ["color.png", "outline.png"]) {
  copyFileSync(join(appDir, icon), join(buildDir, icon));
}

rmSync(zipPath, { force: true });
execSync(`zip -j -q "${zipPath}" manifest.json color.png outline.png`, {
  cwd: buildDir,
});

console.log(`Built ${zipPath}`);
console.log(`  BOT_ID      = ${botId}`);
console.log(`  TUNNEL_HOST = ${tunnelHost}`);
