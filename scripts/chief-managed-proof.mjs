import { PROOF_PHASES } from "../server/chief/managed/constants.js";

const live = process.argv.includes("--live");
const phases = [
  "initial",
  "close",
  "continue_same_store",
  "correct",
  "close",
  "confirm",
  "recover",
];

if (!live) {
  process.stdout.write(
    `${JSON.stringify(
      {
        mode: "dry_run",
        live: false,
        acceptance: "mocked_only",
        phases,
        knownPhases: PROOF_PHASES,
        note: "This script does not call Anthropic or migrate a database. Pass --live only after the identity check, schema readiness, and an explicit spend approval.",
      },
      null,
      2
    )}\n`
  );
  process.exit(0);
}

if (process.env.CHIEF_PROOF_SPEND_APPROVED !== "1") {
  process.stderr.write(
    "Live proof is refused. CHIEF_PROOF_SPEND_APPROVED is not 1, and this assignment does not authorize paid Anthropic calls.\n"
  );
  process.exit(3);
}

process.stderr.write("Live proof execution is not implemented in this assignment.\n");
process.exit(3);
