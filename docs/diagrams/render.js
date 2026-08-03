#!/usr/bin/env node
/**
 * Render the architecture diagrams with DiagramForge and prepare them for
 * inline embedding: namespace every internal id so two SVGs can coexist in one
 * document, and make the root element scale to its container.
 */
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const here = __dirname;
const theme = path.join(here, "themes", "aggregator-dark.json");

const diagrams = [
  { src: "src/dataflow.mmd", out: "dataflow.svg", prefix: "df", label: "Data flow from vendor feeds through the aggregator to your systems" },
  { src: "src/deployed.txt", out: "deployed.svg", prefix: "dp", label: "Azure resources created by the deployment" },
];

for (const d of diagrams) {
  const outPath = path.join(here, d.out);
  execFileSync("dnx", ["DiagramForge.Tool", path.join(here, d.src), "-o", outPath, "--theme-file", theme], { stdio: "inherit" });

  let svg = fs.readFileSync(outPath, "utf8");

  const ids = [...new Set([...svg.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]))];
  for (const id of ids) {
    const safe = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    svg = svg.replace(new RegExp(`(\\sid=")${safe}(")`, "g"), `$1${d.prefix}-${id}$2`);
    svg = svg.replace(new RegExp(`url\\(#${safe}\\)`, "g"), `url(#${d.prefix}-${id})`);
    svg = svg.replace(new RegExp(`(\\s(?:xlink:)?href=")#${safe}(")`, "g"), `$1#${d.prefix}-${id}$2`);
  }

  svg = svg.replace(
    /^<svg([^>]*?)\s+width="[\d.]+"\s+height="[\d.]+"/,
    '<svg$1 role="img" aria-label="' + d.label + '" style="width:100%;height:auto;display:block"',
  );

  fs.writeFileSync(outPath, svg);
  console.log(`prepared ${d.out} (${svg.length} bytes, ${ids.length} ids namespaced)`);
}
