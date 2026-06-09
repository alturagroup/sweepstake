// Seed the 2026 World Cup nations into the configured store.
//
// Usage:
//   npm run build               # ensure dist/ is current
//   node --env-file=.env scripts/seed-teams.mjs
//
// Adds each team via the pure domain rule `addNation`, so name validation and
// case-insensitive uniqueness are enforced. Idempotent: teams already present
// are skipped, so it is safe to re-run. Aborts if assignments already exist
// (nations cannot change once the draw has been run).

import { NeonSweepstakeRepository } from "../dist/src/persistence/neon.js";
import { addNation } from "../dist/src/domain/nations.js";
import { TEAMS_2026 } from "./teams-2026.mjs";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set. Run with: node --env-file=.env scripts/seed-teams.mjs");
  process.exit(1);
}

const repo = await NeonSweepstakeRepository.create(url);
let state = await repo.load();

if (state.assignments.length > 0) {
  console.error(
    "Assignments already exist; nations are locked. Aborting without changes.",
  );
  process.exit(1);
}

let added = 0;
let skipped = 0;
const failures = [];

for (const name of TEAMS_2026) {
  const result = addNation(state, name);
  if (result.ok) {
    state = result.value;
    added += 1;
  } else if (result.error.code === "DUPLICATE_NATION") {
    skipped += 1;
  } else {
    failures.push(`${name}: ${result.error.code}`);
  }
}

if (failures.length > 0) {
  console.error("Some teams could not be added:", failures);
  process.exit(1);
}

// Persist once, after all in-memory additions succeed.
await repo.save(state);

console.log(`Done. Added ${added}, skipped ${skipped} (already present).`);
console.log(`Total nations now: ${state.nations.length}`);
