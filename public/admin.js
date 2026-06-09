// Admin view. Writes require the API token, which is held in localStorage on
// this device only. Reads (lists, dropdowns) are public GETs.
//
// SECURITY NOTE: anyone with access to this page + the saved token can perform
// every write operation. Treat the token like a password; only use this on a
// trusted device.

const TOKEN_KEY = "sweepstake_api_token";

function getToken() {
  return localStorage.getItem(TOKEN_KEY) || "";
}

function setToken(value) {
  if (value) localStorage.setItem(TOKEN_KEY, value);
  else localStorage.removeItem(TOKEN_KEY);
  reflectTokenState();
}

function reflectTokenState() {
  const state = document.getElementById("token-state");
  state.textContent = getToken()
    ? "Token saved on this device."
    : "No token saved. Writes will be rejected until you save one.";
}

function toast(message, kind) {
  const el = document.getElementById("toast");
  el.textContent = message;
  el.className = `toast show ${kind === "err" ? "err" : "ok"}`;
  setTimeout(() => {
    el.className = "toast";
  }, 3200);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

async function api(method, path, body) {
  const headers = { accept: "application/json" };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (method !== "GET") {
    const token = getToken();
    if (!token) throw new Error("Save the API token first.");
    headers.authorization = `Bearer ${token}`;
  }
  const res = await fetch(path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text.length > 0 ? JSON.parse(text) : null;
  if (!res.ok) {
    throw new Error((data && data.message) || `Request failed (${res.status})`);
  }
  return data;
}

// --- Data loading ---------------------------------------------------------

async function refreshParticipants() {
  const list = document.getElementById("participant-list");
  const participants = await api("GET", "/participants");
  list.innerHTML = "";
  for (const p of participants) {
    const li = document.createElement("li");
    li.innerHTML = `<span>${escapeHtml(p.displayName)}</span>`;
    const btn = document.createElement("button");
    btn.textContent = "Remove";
    btn.className = "secondary";
    btn.onclick = () => removeParticipant(p.id);
    li.appendChild(btn);
    list.appendChild(li);
  }
}

async function refreshNations() {
  const nations = await api("GET", "/nations");
  const list = document.getElementById("nation-list");
  list.innerHTML = "";
  for (const n of nations) {
    const li = document.createElement("li");
    li.innerHTML = `<span>${escapeHtml(n.displayName)}</span>`;
    const btn = document.createElement("button");
    btn.textContent = "Remove";
    btn.className = "secondary";
    btn.onclick = () => removeNation(n.id);
    li.appendChild(btn);
    list.appendChild(li);
  }
  // Populate nation dropdowns.
  for (const id of ["match-a", "match-b", "champion"]) {
    const sel = document.getElementById(id);
    const current = sel.value;
    sel.innerHTML = "";
    for (const n of nations) {
      const opt = document.createElement("option");
      opt.value = n.id;
      opt.textContent = n.displayName;
      sel.appendChild(opt);
    }
    if (current) sel.value = current;
  }
}

async function refreshAll() {
  await Promise.all([
    refreshParticipants().catch((e) => toast(e.message, "err")),
    refreshNations().catch((e) => toast(e.message, "err")),
    refreshLeagues().catch((e) => toast(e.message, "err")),
  ]);
  await refreshFixtures().catch((e) => toast(e.message, "err"));
}

// --- Leagues -------------------------------------------------------------

async function refreshLeagues() {
  const list = document.getElementById("league-list");
  if (!list) return;
  const leagues = await api("GET", "/api/leagues");
  list.innerHTML = "";
  if (!Array.isArray(leagues) || leagues.length === 0) {
    list.innerHTML = '<li class="muted">No leagues yet.</li>';
    return;
  }
  for (const lg of leagues) {
    const li = document.createElement("li");
    li.style.flexWrap = "wrap";
    const link = `${location.origin}/l/${lg.slug}`;
    const info = document.createElement("span");
    info.innerHTML =
      `<strong>${escapeHtml(lg.name)}</strong> ` +
      `<a href="/l/${encodeURIComponent(lg.slug)}" target="_blank">${escapeHtml(link)}</a> ` +
      `<span class="muted">— ${lg.participantCount} players${lg.assigned ? ", drawn" : ""}</span>`;

    const controls = document.createElement("span");
    controls.className = "row";
    controls.style.flex = "1 1 100%";
    controls.style.marginTop = "0.35rem";
    controls.innerHTML =
      `<input placeholder="Add player name" data-role="pname" style="flex:1 1 10rem" />`;
    const addBtn = document.createElement("button");
    addBtn.textContent = "Add player";
    addBtn.onclick = () => {
      const name = controls.querySelector('[data-role="pname"]').value.trim();
      if (!name) return toast("Enter a player name.", "err");
      run(async () => { await api("POST", `/api/leagues/${encodeURIComponent(lg.slug)}/participants`, { name }); }, "Player added.");
    };
    const drawBtn = document.createElement("button");
    drawBtn.textContent = lg.assigned ? "Re-draw" : "Run draw";
    drawBtn.className = "secondary";
    drawBtn.onclick = () =>
      run(() => api("POST", `/api/leagues/${encodeURIComponent(lg.slug)}/assign`, { confirmReplace: lg.assigned }), "Draw complete.");
    const finBtn = document.createElement("button");
    finBtn.textContent = "Finalize";
    finBtn.className = "secondary";
    finBtn.onclick = () => run(() => api("POST", `/api/leagues/${encodeURIComponent(lg.slug)}/finalize`), "League finalized.");
    const delBtn = document.createElement("button");
    delBtn.textContent = "Delete";
    delBtn.className = "secondary";
    delBtn.onclick = () => { if (confirm(`Delete league "${lg.name}"? This cannot be undone.`)) run(() => api("DELETE", `/api/leagues/${encodeURIComponent(lg.slug)}`), "League deleted."); };

    const copyBtn = document.createElement("button");
    copyBtn.textContent = "Copy link";
    copyBtn.className = "secondary";
    copyBtn.onclick = async () => {
      try { await navigator.clipboard.writeText(link); toast("Link copied.", "ok"); }
      catch { toast("Copy failed — select the link manually.", "err"); }
    };

    controls.appendChild(addBtn);
    controls.appendChild(drawBtn);
    controls.appendChild(finBtn);
    controls.appendChild(copyBtn);
    controls.appendChild(delBtn);
    li.appendChild(info);
    li.appendChild(controls);
    list.appendChild(li);
  }
}

// --- Fixtures (group-stage schedule) -------------------------------------

let scheduleCache = null;

/** Build a lookup from a nation's display name to its id. */
function nationIdMap(nations) {
  const map = new Map();
  for (const n of nations) map.set(n.displayName, n.id);
  return map;
}

/** Unordered-pair key so a stored match matches a fixture regardless of order. */
function pairKey(aId, bId) {
  return [aId, bId].sort().join("|");
}

async function refreshFixtures() {
  const container = document.getElementById("fixtures");
  if (scheduleCache === null) {
    const res = await fetch("/schedule.json", { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error("Could not load the fixture schedule.");
    scheduleCache = await res.json();
  }

  const [nations, matches] = await Promise.all([
    api("GET", "/nations"),
    api("GET", "/matches"),
  ]);
  const idByName = nationIdMap(nations);

  // Index recorded results by unordered nation-pair for pre-filling.
  const stored = new Map();
  for (const m of matches) {
    stored.set(pairKey(m.nationAId, m.nationBId), m);
  }

  // Populate the group filter once.
  const filter = document.getElementById("group-filter");
  if (filter.options.length === 0) {
    const groups = [...new Set(scheduleCache.fixtures.map((f) => f.group))].sort();
    filter.innerHTML = `<option value="ALL">All</option>` +
      groups.map((g) => `<option value="${g}">Group ${g}</option>`).join("");
    filter.onchange = renderFixtures;
  }

  // Stash resolved data for the renderer.
  container._data = { idByName, stored };
  renderFixtures();
}

function renderFixtures() {
  const container = document.getElementById("fixtures");
  const data = container._data;
  if (!data) return;
  const { idByName, stored } = data;
  const selected = document.getElementById("group-filter").value || "ALL";

  const fixtures = scheduleCache.fixtures
    .filter((f) => selected === "ALL" || f.group === selected)
    .sort((a, b) => a.match - b.match);

  container.innerHTML = "";
  const ul = document.createElement("ul");
  ul.className = "pill-list";

  for (const f of fixtures) {
    const aId = idByName.get(f.home);
    const bId = idByName.get(f.away);
    const li = document.createElement("li");
    li.style.flexWrap = "wrap";

    if (!aId || !bId) {
      li.innerHTML = `<span class="muted">${escapeHtml(f.home)} v ${escapeHtml(f.away)} — team not found in database</span>`;
      ul.appendChild(li);
      continue;
    }

    const existing = stored.get(pairKey(aId, bId));
    // Determine which stored side corresponds to home/away for pre-fill.
    let homeGoals = "";
    let awayGoals = "";
    if (existing) {
      if (existing.nationAId === aId) {
        homeGoals = existing.goalsA; awayGoals = existing.goalsB;
      } else {
        homeGoals = existing.goalsB; awayGoals = existing.goalsA;
      }
    }

    const label = document.createElement("span");
    label.innerHTML =
      `<strong>${f.group}${existing ? " ✓" : ""}</strong> ` +
      `${escapeHtml(f.home)} <input type="number" min="0" max="99" style="width:3.5rem" value="${homeGoals}"> ` +
      `– <input type="number" min="0" max="99" style="width:3.5rem" value="${awayGoals}"> ${escapeHtml(f.away)}`;
    const inputs = label.querySelectorAll("input");

    const save = document.createElement("button");
    save.textContent = existing ? "Update" : "Save";
    save.onclick = () => {
      const gh = Number(inputs[0].value);
      const ga = Number(inputs[1].value);
      const body = { nationAId: aId, nationBId: bId, goalsA: gh, goalsB: ga };
      const method = existing ? "PUT" : "POST";
      run(() => api(method, "/matches", body), `Saved ${f.home} ${gh}–${ga} ${f.away}.`);
    };

    li.appendChild(label);
    li.appendChild(save);
    ul.appendChild(li);
  }
  container.appendChild(ul);
}

// --- Actions --------------------------------------------------------------

async function run(action, okMessage) {
  try {
    await action();
    toast(okMessage, "ok");
    await refreshAll();
  } catch (e) {
    toast(e.message, "err");
  }
}

function addParticipant() {
  const input = document.getElementById("participant-name");
  const name = input.value.trim();
  if (!name) return toast("Enter a name.", "err");
  run(async () => {
    await api("POST", "/participants", { name });
    input.value = "";
  }, "Participant added.");
}

function removeParticipant(id) {
  run(() => api("DELETE", `/participants/${encodeURIComponent(id)}`), "Participant removed.");
}

function addNation() {
  const input = document.getElementById("nation-name");
  const name = input.value.trim();
  if (!name) return toast("Enter a name.", "err");
  run(async () => {
    await api("POST", "/nations", { name });
    input.value = "";
  }, "Nation added.");
}

function removeNation(id) {
  run(() => api("DELETE", `/nations/${encodeURIComponent(id)}`), "Nation removed.");
}

function matchBody() {
  return {
    nationAId: document.getElementById("match-a").value,
    nationBId: document.getElementById("match-b").value,
    goalsA: Number(document.getElementById("goals-a").value),
    goalsB: Number(document.getElementById("goals-b").value),
  };
}

// --- Wire up --------------------------------------------------------------

document.getElementById("save-token").onclick = () => {
  setToken(document.getElementById("token").value.trim());
  document.getElementById("token").value = "";
  toast("Token saved.", "ok");
};
document.getElementById("clear-token").onclick = () => {
  setToken("");
  toast("Token cleared.", "ok");
};

document.getElementById("add-participant").onclick = addParticipant;
document.getElementById("add-nation").onclick = addNation;
const createLeagueBtn = document.getElementById("create-league");
if (createLeagueBtn) {
  createLeagueBtn.onclick = () => {
    const name = document.getElementById("league-name-in").value.trim();
    const password = document.getElementById("league-pass-in").value;
    if (!name) return toast("Enter a league name.", "err");
    run(async () => {
      // Server derives an unguessable slug from the name + a random token.
      await api("POST", "/api/leagues", { name, slug: name, password });
      document.getElementById("league-name-in").value = "";
      document.getElementById("league-pass-in").value = "";
    }, "League created.");
  };
}
document.getElementById("assign").onclick = () =>
  run(() => api("POST", "/assignments", {}), "Assignment complete.");
document.getElementById("assign-replace").onclick = () =>
  run(() => api("POST", "/assignments", { confirmReplace: true }), "Assignment replaced.");
document.getElementById("record-match").onclick = () =>
  run(() => api("POST", "/matches", matchBody()), "Match recorded.");
document.getElementById("update-match").onclick = () =>
  run(() => api("PUT", "/matches", matchBody()), "Match updated.");
document.getElementById("record-champion").onclick = () =>
  run(() => api("POST", "/champion", { nationId: document.getElementById("champion").value }), "Champion recorded.");
document.getElementById("finalize").onclick = () =>
  run(() => api("POST", "/league/finalize"), "League finalized.");

reflectTokenState();
refreshAll();
