// One-shot migration: copy shared tournament facts (nations, matches, champion)
// from the legacy single-tenant `sweepstake_state` row into the new
// `tournament_state` row used by the multi-league model.
//
// Idempotent and non-destructive: it does NOT delete the old row, and it only
// writes tournament_state if that table is currently empty (so re-running is
// safe and won't clobber later edits made via the league admin).
//
// Usage:  npm run build && node --env-file=.env scripts/migrate-to-tournament.mjs

import { NeonLeagueRepository, emptyTournament } from "../dist/src/persistence/leagues.js";
import { NeonSweepstakeRepository } from "../dist/src/persistence/neon.js";

const url = process.env.DATABASE_URL;
if (!url) { console.error("DATABASE_URL not set."); process.exit(1); }

const legacy = await NeonSweepstakeRepository.create(url);
const leagueRepo = await NeonLeagueRepository.create(url);

const existing = await leagueRepo.loadTournament();
if (existing.nations.length > 0 || existing.matches.length > 0 || existing.championNationId) {
  console.log("tournament_state already populated; nothing to do.");
  console.log(`  nations=${existing.nations.length} matches=${existing.matches.length} champion=${existing.championNationId ?? "none"}`);
  process.exit(0);
}

const old = await legacy.load();
const tournament = {
  ...emptyTournament(),
  nations: old.nations,
  matches: old.matches,
  championNationId: old.championNationId,
};
await leagueRepo.saveTournament(tournament);

console.log("Migrated into tournament_state:");
console.log(`  nations=${tournament.nations.length} matches=${tournament.matches.length} champion=${tournament.championNationId ?? "none"}`);
console.log("Legacy sweepstake_state row left intact.");
