// The start command on Railway:  node start.mjs
// Runs the auto-trade worker. APP_ROLE must be unset or "worker"; anything else STOPS (a typo must never start something else).
const role = (process.env.APP_ROLE ?? "").trim().toLowerCase();
if (role !== "" && role !== "worker") {
  console.error(`\nSTOP: APP_ROLE must be unset or "worker", got ${JSON.stringify(process.env.APP_ROLE)}.\n`);
  process.exit(1);
}
console.log(`start: APP_ROLE=${role || "(unset, using the default)"} -> worker/main.ts`);
await import("./worker/main.ts");
