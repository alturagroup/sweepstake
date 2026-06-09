// Public standings view. Reads are unauthenticated GETs, so no token is needed.
//
// Points and ranks come from the authoritative /league-table (current rules:
// Win 3 / Draw 1 / Goal 1). W/D/L/Goals/Form are derived here from
// /assignments + /matches — all real, computed data. No fabricated "bonus".

// --- Editable presentation config ---------------------------------------
const CONFIG = {
  prize: "£500",
  finalDate: "19 JULY 2026",
  // Final kickoff (Eastern Time, ET = UTC-4 in July). Used for the countdown.
  finalDateTimeISO: "2026-07-19T15:00:00-04:00",
};

async function getJson(path) {
  const res = await fetch(path, { headers: { accept: "application/json" } });
  const text = await res.text();
  const body = text.length > 0 ? JSON.parse(text) : null;
  if (!res.ok) throw new Error((body && body.message) || `Request failed (${res.status})`);
  return body;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

// --- Derived per-player stats from assignments + matches -----------------

function computeStats(assignments, matches) {
  // nationId -> participantId
  const owner = new Map();
  for (const a of assignments) owner.set(a.nationId, a.participantId);

  // participantId -> stats accumulator
  const stats = new Map();
  const ensure = (pid) => {
    if (!stats.has(pid)) stats.set(pid, { w: 0, d: 0, l: 0, goals: 0, form: [] });
    return stats.get(pid);
  };

  // Process matches in stored order so "form" reflects entry order.
  for (const m of matches) {
    const sides = [
      { nation: m.nationAId, gf: m.goalsA, ga: m.goalsB },
      { nation: m.nationBId, gf: m.goalsB, ga: m.goalsA },
    ];
    for (const side of sides) {
      const pid = owner.get(side.nation);
      if (pid === undefined) continue; // unassigned nation: ignore
      const s = ensure(pid);
      s.goals += side.gf;
      if (side.gf > side.ga) { s.w += 1; s.form.push("w"); }
      else if (side.gf === side.ga) { s.d += 1; s.form.push("d"); }
      else { s.l += 1; s.form.push("l"); }
    }
  }
  return stats;
}

function formStrip(form) {
  const last5 = form.slice(-5);
  if (last5.length === 0) return '<span class="muted">—</span>';
  return '<span class="form">' +
    last5.map((r) => `<span class="dot ${r}">${r.toUpperCase()}</span>`).join("") +
    "</span>";
}

function renderPodium(rows, teamsByPlayer) {
  const el = document.getElementById("podium");
  if (rows.length < 3) { el.hidden = true; return; }
  const order = [
    { row: rows[1], cls: "second", n: 2 },
    { row: rows[0], cls: "first", n: 1 },
    { row: rows[2], cls: "third", n: 3 },
  ];
  el.innerHTML = order.map(({ row, cls, n }) => {
    const teams = teamsByPlayer.get(row.participantId) || [];
    const teamLabel = teams.length === 1 ? teams[0] : `${teams.length} teams`;
    return `<div class="slot ${cls}">
      <div class="rank-num">${n}</div>
      <div class="name">${escapeHtml(row.displayName)}</div>
      <div class="team">${escapeHtml(teamLabel)}</div>
      <div class="pts">${row.totalPoints} PTS</div>
    </div>`;
  }).join("");
  el.hidden = false;
}

function renderTable(rows, stats, teamsByPlayer) {
  const status = document.getElementById("league-status");
  const table = document.getElementById("league-table");
  const tbody = table.querySelector("tbody");
  tbody.innerHTML = "";
  if (rows.length === 0) {
    status.textContent = "No participants yet.";
    table.hidden = true;
    return;
  }
  for (const row of rows) {
    const s = stats.get(row.participantId) || { w: 0, d: 0, l: 0, goals: 0, form: [] };
    const teams = teamsByPlayer.get(row.participantId) || [];
    const teamLabel = teams.length === 0 ? "—" : teams.length <= 2 ? teams.join(", ") : `${teams.length} teams`;
    const tr = document.createElement("tr");
    tr.innerHTML =
      `<td class="num">${row.rank}</td>` +
      `<td>${escapeHtml(row.displayName)}</td>` +
      `<td>${escapeHtml(teamLabel)}</td>` +
      `<td class="num">${s.w}</td>` +
      `<td class="num">${s.d}</td>` +
      `<td class="num">${s.l}</td>` +
      `<td class="num">${s.goals}</td>` +
      `<td class="num pts-cell">${row.totalPoints}</td>` +
      `<td>${formStrip(s.form)}</td>`;
    tbody.appendChild(tr);
  }
  status.hidden = true;
  table.hidden = false;
}

function teamsByPlayerMap(assignments, nations) {
  const nameById = new Map(nations.map((n) => [n.id, n.displayName]));
  const map = new Map();
  for (const a of assignments) {
    if (!map.has(a.participantId)) map.set(a.participantId, []);
    map.get(a.participantId).push(nameById.get(a.nationId) || a.nationId);
  }
  return map;
}

async function loadPrizes() {
  try {
    const tw = await getJson("/prizes/tournament-winner");
    const el = document.getElementById("tournament-winner-line");
    if (tw && tw.status === "CHAMPION_NOT_RECORDED") el.textContent = "Holder of the champion nation — decided at the final.";
    else if (tw && tw.winner) el.textContent = `Winner: ${tw.winner.displayName}`;
  } catch { /* leave default */ }
  try {
    const lp = await getJson("/prizes/league");
    const el = document.getElementById("league-prize-line");
    if (lp && lp.status === "LEAGUE_NOT_FINALIZED") el.textContent = "Not finalized yet.";
    else if (lp && Array.isArray(lp.recipients)) el.textContent = lp.recipients.length ? lp.recipients.map((p) => p.displayName).join(", ") : "—";
  } catch { /* leave default */ }
}

// --- Countdown -----------------------------------------------------------
function startCountdown() {
  const el = document.getElementById("countdown");
  const target = new Date(CONFIG.finalDateTimeISO).getTime();
  if (Number.isNaN(target)) { el.textContent = "—"; return; }
  const tick = () => {
    const diff = target - Date.now();
    if (diff <= 0) { el.textContent = "Kick-off!"; return; }
    const d = Math.floor(diff / 86400000);
    const h = Math.floor((diff % 86400000) / 3600000);
    const m = Math.floor((diff % 3600000) / 60000);
    const s = Math.floor((diff % 60000) / 1000);
    el.textContent = `${d}d ${h}h ${m}m ${s}s`;
  };
  tick();
  setInterval(tick, 1000);
}

async function refresh() {
  // Apply config text.
  document.getElementById("prize-amount").textContent = CONFIG.prize;
  document.getElementById("prize-inline").textContent = CONFIG.prize;
  document.getElementById("prize-big").textContent = CONFIG.prize;
  document.getElementById("final-date").textContent = CONFIG.finalDate;

  try {
    const [rows, assignments, matches, nations] = await Promise.all([
      getJson("/league-table"),
      getJson("/assignments"),
      getJson("/matches"),
      getJson("/nations"),
    ]);
    // /assignments returns [{ participant, nations:[...] }]; flatten to pairs.
    const flatAssignments = [];
    for (const a of assignments) {
      for (const n of a.nations) flatAssignments.push({ participantId: a.participant.id, nationId: n.id });
    }
    const stats = computeStats(flatAssignments, matches);
    const teams = teamsByPlayerMap(flatAssignments, nations);
    renderPodium(rows, teams);
    renderTable(rows, stats, teams);
  } catch (e) {
    document.getElementById("league-status").textContent = "Could not load standings: " + e.message;
  }
  loadPrizes();
}

startCountdown();
refresh();
