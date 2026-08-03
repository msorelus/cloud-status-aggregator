import { loadConfig } from "./config";
import { createApp } from "./app";
import { StatusWatcher } from "./watch";

const config = loadConfig();

// The watcher is what turns Microsoft's pull-only public feed into a push feed
// downstream. It is opt-in so the API can also be run as a plain read service.
const watcher = config.watchEnabled ? new StatusWatcher(config) : undefined;
const app = createApp(config, watcher);

const server = app.listen(config.port, () => {
  // eslint-disable-next-line no-console
  console.log(
    `Cloud status aggregator listening on :${config.port} (mode=${
      config.mock ? "mock" : "live"
    })`
  );
  if (watcher) {
    watcher.start();
    // eslint-disable-next-line no-console
    console.log(
      `Change watcher on: polling every ${Math.round(
        config.watchIntervalMs / 1000
      )}s -> ${
        config.webhookUrl
          ? `webhook ${config.webhookUrl}${
              config.webhookSecret ? " (HMAC signed)" : " (UNSIGNED)"
            }`
          : "no webhook configured; changes recorded at /api/status/changes only"
      }`
    );
  } else {
    // eslint-disable-next-line no-console
    console.log(
      "Change watcher off. Set WATCH_ENABLED=true to detect new incidents and publish them."
    );
  }
});

function shutdown(signal: string): void {
  // eslint-disable-next-line no-console
  console.log(`${signal} received, shutting down.`);
  watcher?.stop();
  server.close(() => process.exit(0));
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
