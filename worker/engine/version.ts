// The worker release. Sent with every report (so CandleOdds can see which version each bot runs) and checked by
// scripts/export-worker.mjs, which refuses to export under a different version number.
export const WORKER_VERSION = "1.0.2";
