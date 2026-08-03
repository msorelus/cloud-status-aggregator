/**
 * Verification listener for the live webhook drill. Independently recomputes the
 * HMAC over the exact raw bytes received and compares in constant time — the
 * same thing your own subscriber must do.
 */
const http = require("http");
const { createHmac, timingSafeEqual } = require("crypto");

const SECRET = process.env.WEBHOOK_SECRET;
if (!SECRET) throw new Error("WEBHOOK_SECRET required");

http
  .createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks);
      const expected =
        "sha256=" + createHmac("sha256", SECRET).update(raw).digest("hex");
      const got = String(req.headers["x-aggregator-signature"] || "");
      const valid =
        got.length === expected.length &&
        timingSafeEqual(Buffer.from(got), Buffer.from(expected));

      let p = {};
      try {
        p = JSON.parse(raw.toString());
      } catch (e) {
        console.log("  ! body was not JSON");
      }

      console.log("\n--- INBOUND WEBHOOK ---");
      console.log("  content-type : %s", req.headers["content-type"]);
      console.log("  user-agent   : %s", req.headers["user-agent"]);
      console.log("  signature    : %s", got.slice(0, 24) + "...");
      console.log("  SIGNATURE    : %s", valid ? "VALID" : "*** INVALID ***");
      console.log("  specVersion  : %s", p.specVersion);
      console.log("  vendor       : %s", p.vendor);
      console.log("  source       : %s", p.source);
      console.log("  overall      : %s", p.overall);
      console.log("  counts       : %s", JSON.stringify(p.counts));
      for (const c of p.changes || []) {
        console.log(
          "    [%s] %s :: %s",
          c.kind,
          c.issue && c.issue.trackingId ? c.issue.trackingId : "n/a",
          c.issue ? c.issue.title : "?"
        );
      }

      // Reject anything that fails verification — exactly as production should.
      if (!valid) {
        res.writeHead(401, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: "bad signature" }));
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ received: (p.changes || []).length }));
    });
  })
  .listen(9100, () => console.log("verification listener up on :9100"));
