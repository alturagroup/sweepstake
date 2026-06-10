// Per-league public view at /l/{slug}. Password gate, then standings.
//
// Live draw: the page polls the view every few seconds. When the set of
// assignments first appears (or changes), it animates a "draw reveal" of each
// player's teams, then shows the standings. This gives a live, auto-updating
// experience without any realtime infrastructure — it animates already-saved
// data fetched on a timer.

const slug = location.pathname.replace(/^\/l\//, "").replace(/\/+$/, "");
const POLL_MS = 5000;
/** localStorage key for the last draw signature this browser has already seen revealed. */
const SEEN_KEY = `sweepstake_seen_draw_${slug}`;

let pollTimer = null;
let lastAssignmentSig = null; // signature of the last-seen assignment set
let revealing = false;        // suppress re-render churn during an animation

function seenDraw(sig) {
  try { return localStorage.getItem(SEEN_KEY) === sig; } catch { return false; }
}
function markSeen(sig) {
  try { localStorage.setItem(SEEN_KEY, sig); } catch { /* ignore */ }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

async function fetchView() {
  return fetch(`/api/leagues/${encodeURIComponent(slug)}/view`, {
    headers: { accept: "application/json" },
    credentials: "same-origin",
  });
}

/** Stable signature of who-has-which-teams, to detect draw changes. */
function assignmentSignature(view) {
  return view.assignments
    .map((row) => `${row.participant.id}:${row.nations.map((n) => n.id).sort().join(",")}`)
    .sort()
    .join("|");
}

function teamsByPlayer(view) {
  const teams = new Map();
  for (const row of view.assignments) {
    teams.set(row.participant.id, row.nations.map((n) => n.displayName));
  }
  return teams;
}

function formStrip(form) {
  const last5 = (form || []).slice(-5);
  if (last5.length === 0) return '<span class="muted">—</span>';
  return '<span class="form">' + last5.map((r) => `<span class="dot ${r}">${r.toUpperCase()}</span>`).join("") + "</span>";
}

function computeStats(view) {
  const owner = new Map();
  const teams = new Map();
  for (const row of view.assignments) {
    for (const n of row.nations) {
      owner.set(n.id, row.participant.id);
      if (!teams.has(row.participant.id)) teams.set(row.participant.id, []);
      teams.get(row.participant.id).push(n.displayName);
    }
  }
  const stats = new Map();
  const ensure = (pid) => { if (!stats.has(pid)) stats.set(pid, { w: 0, d: 0, l: 0, goals: 0, form: [] }); return stats.get(pid); };
  for (const m of view.matches) {
    for (const side of [{ id: m.nationAId, gf: m.goalsA, ga: m.goalsB }, { id: m.nationBId, gf: m.goalsB, ga: m.goalsA }]) {
      const pid = owner.get(side.id);
      if (pid === undefined) continue;
      const s = ensure(pid);
      s.goals += side.gf;
      if (side.gf > side.ga) { s.w++; s.form.push("w"); }
      else if (side.gf === side.ga) { s.d++; s.form.push("d"); }
      else { s.l++; s.form.push("l"); }
    }
  }
  return { stats, teams };
}

function renderStandings(view) {
  document.getElementById("league-name").textContent = (view.name || "League").toUpperCase();
  const { stats, teams } = computeStats(view);
  const rows = view.leagueTable;

  const podium = document.getElementById("podium");
  if (rows.length >= 3) {
    const order = [{ r: rows[1], c: "second", n: 2 }, { r: rows[0], c: "first", n: 1 }, { r: rows[2], c: "third", n: 3 }];
    podium.innerHTML = order.map(({ r, c, n }) => {
      const t = teams.get(r.participantId) || [];
      const label = t.length === 1 ? t[0] : `${t.length} teams`;
      return `<div class="slot ${c}"><div class="rank-num">${n}</div><div class="name">${escapeHtml(r.displayName)}</div><div class="team">${escapeHtml(label)}</div><div class="pts">${r.totalPoints} PTS</div></div>`;
    }).join("");
    podium.hidden = false;
  } else {
    podium.hidden = true;
  }

  const status = document.getElementById("league-status");
  const table = document.getElementById("league-table");
  const tbody = table.querySelector("tbody");
  tbody.innerHTML = "";
  if (rows.length === 0) { status.textContent = "No participants yet."; status.hidden = false; table.hidden = true; }
  else {
    for (const row of rows) {
      const s = stats.get(row.participantId) || { w: 0, d: 0, l: 0, goals: 0, form: [] };
      const t = teams.get(row.participantId) || [];
      const label = t.length === 0 ? "—" : t.length <= 2 ? t.join(", ") : `${t.length} teams`;
      const tr = document.createElement("tr");
      tr.innerHTML = `<td class="num">${row.rank}</td><td>${escapeHtml(row.displayName)}</td><td>${escapeHtml(label)}</td><td class="num">${s.w}</td><td class="num">${s.d}</td><td class="num">${s.l}</td><td class="num">${s.goals}</td><td class="num pts-cell">${row.totalPoints}</td><td>${formStrip(s.form)}</td>`;
      tbody.appendChild(tr);
    }
    status.hidden = true; table.hidden = false;
  }

  const prize = document.getElementById("prize-line");
  if (view.leagueFinalized && view.leaguePrize) {
    prize.textContent = "League prize: " + view.leaguePrize.map((p) => p.displayName).join(", ");
  } else {
    prize.textContent = "League not finalized yet.";
  }
}

/**
 * Animate the draw reveal: each player's card drops in one after another with
 * a staggered delay, their teams highlighted. Resolves when fully revealed.
 */
function playReveal(view) {
  return new Promise((resolve) => {
    const el = document.getElementById("draw-reveal");
    const teams = teamsByPlayer(view);
    const players = view.assignments.filter((row) => row.nations.length > 0);
    if (players.length === 0) { el.hidden = true; resolve(); return; }

    revealing = true;
    el.hidden = false;
    el.innerHTML = `<h3>🎲 The draw is in!</h3><div class="reveal-grid"></div>`;
    const grid = el.querySelector(".reveal-grid");

    const STEP = 600; // ms between cards
    players.forEach((row, i) => {
      const card = document.createElement("div");
      card.className = "reveal-card";
      card.style.animationDelay = `${i * STEP}ms`;
      const names = (teams.get(row.participant.id) || []);
      card.innerHTML =
        `<div class="player">${escapeHtml(row.participant.displayName)}</div>` +
        `<div class="teams">${names.map((n) => `<span class="new">${escapeHtml(n)}</span>`).join("")}</div>`;
      grid.appendChild(card);
    });

    const total = players.length * STEP + 600;
    setTimeout(() => { revealing = false; resolve(); }, total);
  });
}

async function tick(initial) {
  let res;
  try { res = await fetchView(); } catch { return; }

  if (res.status === 401) { stopPolling(); showGate(""); return; }
  if (res.status === 404) { stopPolling(); showGate("No league found for this link."); return; }
  if (res.status !== 200) return;

  const view = await res.json();
  document.getElementById("gate").hidden = true;
  document.getElementById("standings").hidden = false;
  document.getElementById("live-dot").hidden = false;

  const sig = assignmentSignature(view);
  const hasDraw = view.assignments.some((r) => r.nations.length > 0);
  lastAssignmentSig = sig;

  // Reveal once per browser per draw: if there's a draw this browser hasn't
  // seen yet, play the animation — even on first load (so people arriving just
  // after the draw is triggered still get the reveal). Refreshes and return
  // visits skip it because the signature is remembered in localStorage.
  if (hasDraw && !seenDraw(sig) && !revealing) {
    markSeen(sig);
    await playReveal(view);
    renderStandings(view);
    return;
  }

  if (!hasDraw) document.getElementById("draw-reveal").hidden = true;
  if (!revealing) renderStandings(view);
}

function startPolling() {
  if (pollTimer !== null) return;
  pollTimer = setInterval(() => tick(false), POLL_MS);
}
function stopPolling() {
  if (pollTimer !== null) { clearInterval(pollTimer); pollTimer = null; }
  document.getElementById("live-dot").hidden = true;
}

function showGate(message) {
  document.getElementById("standings").hidden = true;
  document.getElementById("draw-reveal").hidden = true;
  document.getElementById("gate").hidden = false;
  if (message) document.getElementById("gate-error").textContent = message;
}

async function start() {
  if (!slug) { showGate("Invalid league link."); return; }
  await tick(true);
  if (!document.getElementById("standings").hidden) startPolling();
}

document.getElementById("enter").onclick = async () => {
  const password = document.getElementById("password").value;
  const res = await fetch(`/api/leagues/${encodeURIComponent(slug)}/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify({ password }),
  });
  if (res.ok) {
    document.getElementById("gate-error").textContent = "";
    await tick(true);
    startPolling();
  } else if (res.status === 404) {
    document.getElementById("gate-error").textContent = "No league found for this link.";
  } else {
    document.getElementById("gate-error").textContent = "Incorrect password.";
  }
};

// Pause polling when the tab is hidden; resume (and refresh) when visible.
document.addEventListener("visibilitychange", () => {
  if (document.hidden) stopPolling();
  else if (!document.getElementById("standings").hidden) { tick(false); startPolling(); }
});

start();
