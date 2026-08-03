/**
 * Live validation for the subscription-independent ARM source.
 *
 *   az login           # ensure a valid Azure session
 *   npm run live:check
 *
 * Calls the REAL Microsoft.ResourceHealth/emergingIssues operation via
 * DefaultAzureCredential and prints the normalized result. When Azure is
 * healthy this correctly returns zero issues with ok:true — that is a PASS
 * (it proves auth + HTTP 200 + parsing), not a failure.
 */
import { loadConfig } from "../src/config";
import { getEmergingIssues } from "../src/sources/emergingIssues";
import { getStatusFeed } from "../src/sources/statusFeed";
import { aggregate } from "../src/normalize";

async function main() {
  const config = { ...loadConfig(), mock: false };
  console.log(`ARM base: ${config.armBaseUrl}`);
  console.log(`emergingIssues api-version: ${config.emergingIssuesApiVersion}\n`);

  const [ei, feed] = await Promise.all([
    getEmergingIssues(config),
    getStatusFeed(config),
  ]);

  console.log("== emergingIssues ==");
  console.log(`  ok:    ${ei.ok}`);
  console.log(`  count: ${ei.issues.length}`);
  if (ei.message) console.log(`  note:  ${ei.message}`);

  console.log("\n== statusFeed (public) ==");
  console.log(`  ok:    ${feed.ok}`);
  console.log(`  count: ${feed.issues.length}`);
  if (feed.message) console.log(`  note:  ${feed.message}`);

  const agg = aggregate([ei, feed]);
  console.log("\n== aggregated ==");
  console.log(JSON.stringify({ overall: agg.overall, counts: agg.counts }, null, 2));

  // Success criteria: ARM call authenticated and returned 200 (ok:true).
  if (!ei.ok) {
    console.error(
      "\nFAIL: emergingIssues did not return ok. Run `az login` (or configure a Managed Identity) and retry."
    );
    process.exit(1);
  }
  console.log("\nPASS: emergingIssues authenticated and parsed (count may be 0 when Azure is healthy).");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
