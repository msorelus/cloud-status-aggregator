/**
 * Live webhook drill.
 *
 * Uses the REAL StatusWatcher against the REAL tenant. The watcher deliberately
 * suppresses its first poll (so a restart never replays known incidents), which
 * means a quiet Azure day would never fire. To exercise delivery we seed the
 * baseline as EMPTY rather than null — the genuine "I have a baseline, and it
 * contained nothing" state. Every live incident then diffs as `new` and the
 * real publish path runs: sign -> POST -> record delivery.
 *
 * Nothing is synthesized. Every issue in the payload is one Microsoft actually
 * published to this tenant right now.
 */
const { StatusWatcher } = require("../dist/watch");
const { loadConfig } = require("../dist/config");

async function main() {
  const config = loadConfig();
  console.log("config: mock=%s watchIntervalMs=%s webhook=%s signed=%s",
    config.mock, config.watchIntervalMs, config.webhookUrl, Boolean(config.webhookSecret));

  const watcher = new StatusWatcher(config, "tenant");

  // 1) Real first poll -> primes the baseline, publishes nothing (by design).
  const first = await watcher.poll();
  console.log("\n[poll 1] changes=%d (suppressed first poll, as designed)", first.changes.length);
  console.log("         baseline now holds %d live issue(s)", watcher.previous ? watcher.previous.size : 0);

  // 2) Seed an EMPTY baseline so the next poll diffs live data against nothing.
  watcher.previous = new Map();
  const second = await watcher.poll();
  console.log("\n[poll 2] counts=%s", JSON.stringify(second.counts));
  for (const c of second.changes) {
    console.log("   %s: %s :: %s", c.kind, c.issue.trackingId || "n/a", c.issue.title);
  }

  // Give the fire-and-forget delivery a moment to land.
  await new Promise((r) => setTimeout(r, 1500));
  console.log("\n[delivery] %s", JSON.stringify(watcher.state.lastDelivery));
  console.log("[watcher ] pollCount=%d lastError=%s",
    watcher.state.pollCount, watcher.state.lastError);

  watcher.stop();
  const ok = watcher.state.lastDelivery && watcher.state.lastDelivery.ok;
  console.log(ok ? "\nDRILL PASS: live change published and accepted" : "\nDRILL FAIL");
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error("DRILL ERROR:", e);
  process.exit(1);
});
