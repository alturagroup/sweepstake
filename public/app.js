// Public standings view. Reads are unauthenticated GETs, so no token is needed.

async function getJson(path) {
  const res = await fetch(path, { headers: { accept: "application/json" } });
  const text = await res.text();
  const body = text.length > 0 ? JSON.parse(text) : null;
  if (!res.ok) {
    throw new Error((body && body.message) || `Request failed (${res.status})`);
  }
  return body;
}

function renderLeague(rows) {
  const status = document.getElementById("league-status");
  const table = document.getElementById("league-table");
  const tbody = table.querySelector("tbody");
  tbody.innerHTML = "";

  if (!rows || rows.length === 0) {
    status.textContent = "No participants yet.";
    table.hidden = true;
    return;
  }
  for (const row of rows) {
    const tr = document.createElement("tr");
    tr.innerHTML =
      `<td>${row.rank}</td>` +
      `<td>${escapeHtml(row.displayName)}</td>` +
      `<td>${row.totalPoints}</td>`;
    tbody.appendChild(tr);
  }
  status.hidden = true;
  table.hidden = false;
}

async function loadTournamentWinner() {
  const el = document.getElementById("tournament-winner");
  const data = await getJson("/prizes/tournament-winner");
  if (data && data.status === "CHAMPION_NOT_RECORDED") {
    el.textContent = "Not yet decided";
  } else if (data && data.winner) {
    el.textContent = data.winner.displayName;
  } else {
    el.textContent = "—";
  }
}

async function loadLeaguePrize() {
  const el = document.getElementById("league-prize");
  const data = await getJson("/prizes/league");
  if (data && data.status === "LEAGUE_NOT_FINALIZED") {
    el.textContent = "Not finalized yet";
  } else if (data && Array.isArray(data.recipients)) {
    el.textContent =
      data.recipients.length > 0
        ? data.recipients.map((p) => p.displayName).join(", ")
        : "—";
  } else {
    el.textContent = "—";
  }
}

async function loadAssignments() {
  const el = document.getElementById("assignments");
  const rows = await getJson("/assignments");
  if (!rows || rows.length === 0) {
    el.textContent = "Not assigned yet.";
    return;
  }
  el.innerHTML = "";
  const ul = document.createElement("ul");
  ul.className = "pill-list";
  for (const row of rows) {
    const nations = row.nations.map((n) => escapeHtml(n.displayName)).join(", ");
    const li = document.createElement("li");
    li.innerHTML =
      `<span>${escapeHtml(row.participant.displayName)}</span>` +
      `<span class="muted">${nations || "—"}</span>`;
    ul.appendChild(li);
  }
  el.appendChild(ul);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

async function refresh() {
  try {
    renderLeague(await getJson("/league-table"));
  } catch (e) {
    document.getElementById("league-status").textContent =
      "Could not load standings: " + e.message;
  }
  loadTournamentWinner().catch(() => {});
  loadLeaguePrize().catch(() => {});
  loadAssignments().catch(() => {
    document.getElementById("assignments").textContent = "Could not load assignments.";
  });
}

refresh();
