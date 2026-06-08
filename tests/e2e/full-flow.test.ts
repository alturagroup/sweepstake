import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import type { Rng } from "../../src/domain/assignment.js";
import { buildServer } from "../../src/main.js";
import type { Match, Nation, Participant } from "../../src/domain/types.js";

// End-to-end integration test for the full sweepstake flow
// (Requirements 3.1, 4.1, 6.7, 7.5, 8.4).
//
// This exercises the entire application as composed by the real entry point
// `buildServer(dataFile, rng)` from src/main.ts: the HTTP API over the
// application service over the pure domain core, persisted through the real
// JSON-file repository. The server is built over an ISOLATED temporary data
// file (os.tmpdir + fs.mkdtemp) with a DETERMINISTIC seeded RNG, bound to an
// EPHEMERAL port (listen(0)), and driven end-to-end with genuine HTTP `fetch`
// calls. The temp store is removed on completion so no artifacts persist.
//
// Flow under test:
//   1. POST /participants (a few) and POST /nations (>= participants)
//   2. POST /assignments, then GET /assignments to confirm every nation is
//      assigned to exactly one participant (Req 3.1)
//   3. POST /matches (a few results), then GET /league-table to confirm the
//      standings reflect the recorded matches (Req 4.1, 6.7)
//   4. POST /champion with an assigned nation, then
//      GET /prizes/tournament-winner to confirm the holder (Req 7.5)
//   5. POST /league/finalize, then GET /prizes/league to confirm the rank-1
//      recipient(s) (Req 8.4)

// ---------------------------------------------------------------------------
// Fixtures & helpers
// ---------------------------------------------------------------------------

/**
 * Minimal seeded PRNG (mulberry32) returning a float in [0, 1), satisfying the
 * `Rng` contract so the assignment is deterministic and reproducible across
 * runs.
 */
function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let tempDir: string;
let dataFile: string;
let server: Server;
let baseUrl: string;

beforeAll(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sweepstake-e2e-"));
  dataFile = path.join(tempDir, "state.json");
  server = buildServer(dataFile, mulberry32(0xc0ffee));
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await fs.rm(tempDir, { recursive: true, force: true });
});

interface JsonResponse {
  status: number;
  // biome-ignore lint/suspicious/noExplicitAny: test helper parses arbitrary JSON
  body: any;
}

/** Make an HTTP request to the test server and parse the JSON response. */
async function request(
  method: string,
  pathname: string,
  body?: unknown,
): Promise<JsonResponse> {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { "content-type": "application/json" };
  }
  const res = await fetch(`${baseUrl}${pathname}`, init);
  const text = await res.text();
  return {
    status: res.status,
    body: text.length > 0 ? JSON.parse(text) : null,
  };
}

/** Look up a created entity's generated id by display name from a list endpoint. */
function idByName(list: Array<{ id: string; displayName: string }>, name: string): string {
  const found = list.find((entry) => entry.displayName === name);
  expect(found, `expected to find "${name}" in list`).toBeDefined();
  return (found as { id: string }).id;
}

/**
 * Independent reference implementation of a nation's total points across a set
 * of matches: 3 points for a win, 1 for a draw, plus one point per goal scored.
 * Used to derive the expected league standings independently of the production
 * scoring code.
 */
function referenceNationPoints(matches: Match[], nationId: string): number {
  let total = 0;
  for (const match of matches) {
    if (match.nationAId === nationId) {
      total += match.goalsA;
      total += match.goalsA > match.goalsB ? 3 : match.goalsA === match.goalsB ? 1 : 0;
    } else if (match.nationBId === nationId) {
      total += match.goalsB;
      total += match.goalsB > match.goalsA ? 3 : match.goalsB === match.goalsA ? 1 : 0;
    }
  }
  return total;
}

// ---------------------------------------------------------------------------
// The full flow
// ---------------------------------------------------------------------------

describe("end-to-end: full sweepstake flow over the real composed server", () => {
  const participantNames = ["Alice", "Bob", "Carol"];
  const nationNames = ["Brazil", "France", "Germany", "Spain", "Italy", "Argentina"];

  // Captured across the ordered steps below.
  let nationIdByName: Map<string, string>;
  let participantByNation: Map<string, string>; // nationId -> participantId
  let recordedMatches: Match[];

  it("1. adds participants and nations (>= participants)", async () => {
    for (const name of participantNames) {
      const res = await request("POST", "/participants", { name });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
    }
    for (const name of nationNames) {
      const res = await request("POST", "/nations", { name });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
    }

    const participants = (await request("GET", "/participants")).body as Participant[];
    const nations = (await request("GET", "/nations")).body as Nation[];
    expect(participants).toHaveLength(participantNames.length);
    expect(nations).toHaveLength(nationNames.length);
    expect(nations.length).toBeGreaterThanOrEqual(participants.length);

    nationIdByName = new Map(nations.map((n) => [n.displayName, n.id]));
  });

  it("2. assigns nations and confirms every nation is assigned exactly once (Req 3.1)", async () => {
    const assignRes = await request("POST", "/assignments", {});
    expect(assignRes.status).toBe(200);
    expect(assignRes.body).toEqual({ ok: true });

    const view = (await request("GET", "/assignments")).body as Array<{
      participant: Participant;
      nations: Nation[];
    }>;
    expect(view).toHaveLength(participantNames.length);

    // Every nation appears exactly once across all participants, and the set of
    // assigned nations equals the full nation set (none unassigned, no dupes).
    participantByNation = new Map();
    const assignedNationIds: string[] = [];
    for (const row of view) {
      for (const nation of row.nations) {
        assignedNationIds.push(nation.id);
        participantByNation.set(nation.id, row.participant.id);
      }
    }
    expect(assignedNationIds).toHaveLength(nationNames.length);
    expect(new Set(assignedNationIds).size).toBe(nationNames.length);
    expect(new Set(assignedNationIds)).toEqual(new Set(nationIdByName.values()));

    // Balanced to within one (6 nations / 3 participants => exactly 2 each).
    const counts = view.map((row) => row.nations.length);
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
  });

  it("3. records matches and confirms the league table reflects them (Req 4.1, 6.7)", async () => {
    const n = (name: string): string => nationIdByName.get(name) as string;
    const matchInputs = [
      { nationAId: n("Brazil"), nationBId: n("France"), goalsA: 3, goalsB: 1 },
      { nationAId: n("Germany"), nationBId: n("Spain"), goalsA: 2, goalsB: 2 },
      { nationAId: n("Italy"), nationBId: n("Argentina"), goalsA: 0, goalsB: 4 },
      { nationAId: n("Brazil"), nationBId: n("Germany"), goalsA: 1, goalsB: 0 },
    ];
    for (const input of matchInputs) {
      const res = await request("POST", "/matches", input);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
    }

    recordedMatches = (await request("GET", "/matches")).body as Match[];
    expect(recordedMatches).toHaveLength(matchInputs.length);

    // Independently derive expected per-participant totals from the recorded
    // matches and the assignment mapping, then compare against the served table.
    const expectedByParticipant = new Map<string, number>();
    for (const [nationId, participantId] of participantByNation) {
      const pts = referenceNationPoints(recordedMatches, nationId);
      expectedByParticipant.set(
        participantId,
        (expectedByParticipant.get(participantId) ?? 0) + pts,
      );
    }

    const table = (await request("GET", "/league-table")).body as Array<{
      participantId: string;
      displayName: string;
      totalPoints: number;
      rank: number;
    }>;
    expect(table).toHaveLength(participantNames.length);

    // Standings reflect the matches: each row's points match the independent
    // computation.
    for (const row of table) {
      expect(row.totalPoints).toBe(expectedByParticipant.get(row.participantId) ?? 0);
    }

    // At least one team scored points, so the table is not all-zero — the
    // matches genuinely moved the standings.
    expect(table.some((row) => row.totalPoints > 0)).toBe(true);

    // Ordered by points descending and ranks defined by strictly-greater count.
    for (let i = 1; i < table.length; i++) {
      expect(table[i - 1].totalPoints).toBeGreaterThanOrEqual(table[i].totalPoints);
    }
    for (const row of table) {
      const strictlyGreater = table.filter((r) => r.totalPoints > row.totalPoints).length;
      expect(row.rank).toBe(strictlyGreater + 1);
    }
  });

  it("4. records a champion and confirms the tournament-winner holder (Req 7.5)", async () => {
    // Pick an assigned nation (Brazil) and find the participant who holds it.
    const championNationId = nationIdByName.get("Brazil") as string;
    const expectedHolderId = participantByNation.get(championNationId) as string;
    expect(expectedHolderId).toBeDefined();

    const recordRes = await request("POST", "/champion", { nationId: championNationId });
    expect(recordRes.status).toBe(200);
    expect(recordRes.body).toEqual({ ok: true });

    const prize = await request("GET", "/prizes/tournament-winner");
    expect(prize.status).toBe(200);
    expect(prize.body.winner).toBeDefined();
    expect(prize.body.winner.id).toBe(expectedHolderId);
  });

  it("5. finalizes the league and confirms the rank-1 prize recipient(s) (Req 8.4)", async () => {
    const finalizeRes = await request("POST", "/league/finalize");
    expect(finalizeRes.status).toBe(200);
    expect(finalizeRes.body).toMatchObject({ ok: true, leagueFinalized: true });

    const table = (await request("GET", "/league-table")).body as Array<{
      participantId: string;
      rank: number;
    }>;
    const expectedRankOneIds = new Set(
      table.filter((row) => row.rank === 1).map((row) => row.participantId),
    );
    expect(expectedRankOneIds.size).toBeGreaterThan(0);

    const prize = await request("GET", "/prizes/league");
    expect(prize.status).toBe(200);
    expect(Array.isArray(prize.body.recipients)).toBe(true);
    const recipientIds = new Set(
      (prize.body.recipients as Participant[]).map((p) => p.id),
    );
    // League prize recipients are exactly the rank-1 participants.
    expect(recipientIds).toEqual(expectedRankOneIds);
  });
});
