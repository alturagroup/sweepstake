// Per-league public view at /l/{slug}. Shows a password gate, then the
// standings scoped to that league. The view endpoint relies on an HttpOnly
// cookie set by /login, so no token is stored client-side.

const slug = location.pathname.replace(/^\/l\//, "").replace(/\/+$/, "");

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

async function fetchView() {
  const res = await fetch(`/api/leagues/${encodeURIComponent(slug)}/view`, {
    headers: { accept: "application/json" },
    credentials: "same-origin",
  });
  return res;
}

function formStrip(form) {
  const last5 = (form || []).slice(-5);
  if (last5.length === 0) return '<span class="muted">—</span>';
  return '<span class="form">' + last5.map((r) => `<span class="dot ${r}">${r.toUpperCase()}</span>`).join("") + "</span>";
}

/** Derive W/D/L/Goals/Form per participant from the league view payload. */
function computeStats(view) {
  const owner = new Map(); // nationId -> participantId
  const teams = new Map(); // participantId -> [names]
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

function render(view) {
  document.getElementById("league-name").textContent = (view.name || "League").toUpperCase();
  const { stats, teams } = computeStats(view);
  const rows = view.leagueTable;

  // Podium
  const podium = document.getElementById("podium");
  if (rows.length >= 3) {
    const order = [{ r: rows[1], c: "second", n: 2 }, { r: rows[0], c: "first", n: 1 }, { r: rows[2], c: "third", n: 3 }];
    podium.innerHTML = order.map(({ r, c, n }) => {
      const t = teams.get(r.participantId) || [];
      const label = t.length === 1 ? t[0] : `${t.length} teams`;
      return `<div class="slot ${c}"><div class="rank-num">${n}</div><div class="name">${escapeHtml(r.displayName)}</div><div class="team">${escapeHtml(label)}</div><div class="pts">${r.totalPoints} PTS</div></div>`;
    }).join("");
    podium.hidden = false;
  }

  const status = document.getElementById("league-status");
  const table = document.getElementById("league-table");
  const tbody = table.querySelector("tbody");
  tbody.innerHTML = "";
  if (rows.length === 0) { status.textContent = "No participants yet."; table.hidden = true; }
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

function showGate(message) {
  document.getElementById("standings").hidden = true;
  document.getElementById("gate").hidden = false;
  if (message) document.getElementById("gate-error").textContent = message;
}

async function load() {
  if (!slug) { showGate("Invalid league link."); return; }
  const res = await fetchView();
  if (res.status === 200) {
    document.getElementById("gate").hidden = true;
    document.getElementById("standings").hidden = false;
    render(await res.json());
    return;
  }
  if (res.status === 404) { showGate("No league found for this link."); return; }
  showGate(""); // 401: needs password
}

document.getElementById("enter").onclick = async () => {
  const password = document.getElementById("password").value;
  const res = await fetch(`/api/leagues/${encodeURIComponent(slug)}/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify({ password }),
  });
  if (res.ok) { document.getElementById("gate-error").textContent = ""; load(); }
  else if (res.status === 404) document.getElementById("gate-error").textContent = "No league found for this link.";
  else document.getElementById("gate-error").textContent = "Incorrect password.";
};

load();
