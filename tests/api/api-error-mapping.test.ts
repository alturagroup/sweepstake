import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import * as os from "node:os";
import * as path from "node:path";

import { createApp } from "../../src/api/index.js";
import type { Rng } from "../../src/domain/assignment.js";
import type { Nation, Participant } from "../../src/domain/types.js";
import { JsonFileSweepstakeRepository } from "../../src/persistence/index.js";
import { SweepstakeService } from "../../src/service/index.js";

// Integration tests for the HTTP API error-code mapping
// (Requirements 1.2, 4.2, 4.3, 4.4, 7.2, 7.3).
//
// These tests stand up the real Node HTTP server (createApp) over a real
// SweepstakeService backed by a real JsonFileSweepstakeRepository in an
// isolated temp directory. The server listens on an ephemeral port and we make
// genuine HTTP requests with the global fetch, asserting that each endpoint
// returns the correct HTTP status and JSON body for representative success and
// rejection cases — exercising the full API -> service -> domain -> persistence
// stack rather than any in-memory shortcut.

// ---------------------------------------------------------------------------
// Test fixtures & helpers
// ---------------------------------------------------------------------------

/**
 * Minimal seeded PRNG (mulberry32) returning a float in [0, 1), satisfying the
 * `Rng` contract so assignment is deterministic and reproducible.
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
let server: Server;
let baseUrl: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sweepstake-api-"));
  const filePath = path.join(tempDir, "state.json");
  const service = new SweepstakeService(
    new JsonFileSweepstakeRepository(filePath),
    mulberry32(0x1234_5678),
  );
  server = createApp(service);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await fs.rm(tempDir, { recursive: true, force: true });
});

interface JsonResponse {
  status: number;
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
  return { status: res.status, body: text.length > 0 ? JSON.parse(text) : null };
}

/** Add a participant via the API and return its generated id. */
async function addParticipant(name: string): Promise<string> {
  const res = await request("POST", "/participants", { name });
  expect(res.status).toBe(200);
  const list = (await request("GET", "/participants")).body as Participant[];
  const found = list.find((p) => p.displayName === name);
  expect(found).toBeDefined();
  return (found as Participant).id;
}

/** Add a nation via the API and return its generated id. */
async function addNation(name: string): Promise<string> {
  const res = await request("POST", "/nations", { name });
  expect(res.status).toBe(200);
  const list = (await request("GET", "/nations")).body as Nation[];
  const found = list.find((n) => n.displayName === name);
  expect(found).toBeDefined();
  return (found as Nation).id;
}

// ---------------------------------------------------------------------------
// Success cases
// ---------------------------------------------------------------------------

describe("API success cases return 200 with the expected body", () => {
  it("POST /participants adds a participant and GET lists it", async () => {
    const created = await request("POST", "/participants", { name: "Alice" });
    expect(created.status).toBe(200);
    expect(created.body).toEqual({ ok: true });

    const list = await request("GET", "/participants");
    expect(list.status).toBe(200);
    expect(Array.isArray(list.body)).toBe(true);
    expect(list.body).toHaveLength(1);
    expect(list.body[0]).toMatchObject({
      displayName: "Alice",
      normalizedName: "alice",
    });
  });

  it("POST /nations adds a nation and GET lists it", async () => {
    const created = await request("POST", "/nations", { name: "Brazil" });
    expect(created.status).toBe(200);
    expect(created.body).toEqual({ ok: true });

    const list = await request("GET", "/nations");
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0]).toMatchObject({ displayName: "Brazil" });
  });

  it("POST /matches records a valid match (200)", async () => {
    const brazil = await addNation("Brazil");
    const france = await addNation("France");

    const res = await request("POST", "/matches", {
      nationAId: brazil,
      nationBId: france,
      goalsA: 3,
      goalsB: 1,
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });

    const matches = await request("GET", "/matches");
    expect(matches.status).toBe(200);
    expect(matches.body).toHaveLength(1);
    expect(matches.body[0]).toMatchObject({ goalsA: 3, goalsB: 1 });
  });
});

// ---------------------------------------------------------------------------
// Status-style reads return 200 with an explicit status body
// ---------------------------------------------------------------------------

describe("status-style reads return 200 with a status body before prerequisites", () => {
  it("GET /prizes/tournament-winner before a champion is recorded (200, CHAMPION_NOT_RECORDED)", async () => {
    const res = await request("GET", "/prizes/tournament-winner");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "CHAMPION_NOT_RECORDED" });
  });

  it("GET /prizes/league before the table is finalized (200, LEAGUE_NOT_FINALIZED)", async () => {
    await addParticipant("Alice");
    const res = await request("GET", "/prizes/league");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "LEAGUE_NOT_FINALIZED" });
  });
});

// ---------------------------------------------------------------------------
// Rejection cases: DomainError code -> HTTP status & error body
// ---------------------------------------------------------------------------

describe("API maps domain errors to the correct status and error body", () => {
  it("duplicate participant add -> 409 DUPLICATE_PARTICIPANT (Req 1.2)", async () => {
    await addParticipant("Alice");

    const res = await request("POST", "/participants", { name: "  alice  " });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: "DUPLICATE_PARTICIPANT" });
    expect(typeof res.body.message).toBe("string");
  });

  it("record match with an unknown nation -> 404 UNKNOWN_NATION with nation field (Req 4.2)", async () => {
    const brazil = await addNation("Brazil");

    const res = await request("POST", "/matches", {
      nationAId: brazil,
      nationBId: "missing-nation-id",
      goalsA: 1,
      goalsB: 0,
    });
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({
      code: "UNKNOWN_NATION",
      nation: "missing-nation-id",
    });
  });

  it("record match with identical nations -> 400 NATIONS_NOT_DISTINCT (Req 4.3)", async () => {
    const brazil = await addNation("Brazil");

    const res = await request("POST", "/matches", {
      nationAId: brazil,
      nationBId: brazil,
      goalsA: 1,
      goalsB: 1,
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: "NATIONS_NOT_DISTINCT" });
  });

  it("record match with out-of-range goals -> 400 GOALS_OUT_OF_RANGE (Req 4.4)", async () => {
    const brazil = await addNation("Brazil");
    const france = await addNation("France");

    const res = await request("POST", "/matches", {
      nationAId: brazil,
      nationBId: france,
      goalsA: 100,
      goalsB: 0,
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: "GOALS_OUT_OF_RANGE" });
  });

  it("record champion with an unknown nation -> 404 UNKNOWN_NATION (Req 7.2)", async () => {
    await addParticipant("Alice");
    await addNation("Brazil");

    const res = await request("POST", "/champion", {
      nationId: "missing-nation-id",
    });
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: "UNKNOWN_NATION" });
  });

  it("record champion that exists but is unassigned -> 409 CHAMPION_NOT_ASSIGNED (Req 7.3)", async () => {
    await addParticipant("Alice");
    const brazil = await addNation("Brazil");
    // No assignment has been generated, so Brazil exists but is unassigned.

    const res = await request("POST", "/champion", { nationId: brazil });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: "CHAMPION_NOT_ASSIGNED" });
  });
});
