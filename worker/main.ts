// Entry point for every worker deployment. AUTOTRADE_MODE picks the behaviour:
//
//   shadow (default)  Records what would be traded; places nothing, holds no key.
//   live              Places REAL orders for one wallet (see worker/engine/ and the operator guide).
//
// Two shadow flavours share the mode name:
//   - our own DB-backed shadow worker (worker/shadow.ts): reads signals straight from our
//     database (SIGNALS_DATABASE_URL) and records to our tables. Selected when there is no
//     CANDLEODDS_TOKEN.
//   - the client engine in shadow mode: reads signals over HTTP with a client token and
//     records to the operator's own Postgres. Selected when CANDLEODDS_TOKEN is set.
export {}; // (marks this file as a module so top-level await is allowed)

const raw = (process.env.AUTOTRADE_MODE || "shadow").trim().toLowerCase();
if (raw !== "shadow" && raw !== "live") {
  console.error(`AUTOTRADE_MODE must be "shadow" or "live", got ${JSON.stringify(process.env.AUTOTRADE_MODE)}.`);
  process.exit(1);
}

if (raw === "shadow" && !process.env.CANDLEODDS_TOKEN) {
  try {
    await import("./shadow.ts"); // legacy DB shadow (not present in a client's trimmed copy)
  } catch (e) {
    if ((e as { code?: string }).code !== "ERR_MODULE_NOT_FOUND") throw e;
    console.error("STOP: set CANDLEODDS_TOKEN (and DATABASE_URL). See OPERATOR-GUIDE.md.");
    process.exit(1);
  }
} else {
  const { run } = await import("./engine/run.ts");
  await run(raw);
}
