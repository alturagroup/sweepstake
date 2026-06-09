// Admin console.
//
// Auth is via a password login that sets an HttpOnly session cookie (server
// side). The browser sends the cookie automatically, so no token is stored in
// JS. Writes go to the league/tournament API; reads are public GETs.
//
// Shared tournament data (nations, matches, champion) lives under
// /api/tournament/*. Per-league data (participants, draw, finalize) lives under
// /api/leagues/{slug}/*.

function toast(message, kind) {
  const el = document.getElementById("toast");
  el.textContent = message;
  el.className = `toast show ${kind === "err" ? "err" : "ok"}`;
  setTimeout(() => { el.className = "toast"; }, 3200);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

async function api(method, path, body) {
  const headers = { accept: "application/json" };
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(path, {
    method,
    headers,
    credentials: "same-origin",
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text.length > 0 ? JSON.parse(text) : null;
  if (res.status === 401) {
    showLogin("Session expired. Please log in again.");
    throw new Error("Not logged in.");
  }
  if (!res.ok) throw new Error((data && data.message) || `Request failed (${res.status})`);
  return data;
}

// --- Auth ----------------------------------------------------------------

function showLogin(message) {
  document.getElementById("console").hidden = true;
  document.getElementById("login").hidden = false;
  if (message) document.getElementById("login-state").textContent = message;
}
function showConsole() {
  document.getElementById("login").hidden = true;
  document.getElementById("console").hidden = false;
  refreshAll();
}

async function checkSession() {
  try {
    const res = await fetch("/api/session", { credentials: "same-origin" });
    const data = await res.json();
    if (data.authenticated) showConsole(); else showLogin("");
  } catch { showLogin(""); }
}

document.getElementById("login-btn").onclick = async () => {
  const password = document.getElementById("admin-password").value;
  if (!password) return toast("Enter the admin password.", "err");
  try {
    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ password }),
    });
    if (res.ok) { document.getElementById("admin-password").value = ""; document.getElementById("login-state").textContent = ""; showConsole(); }
    else if (res.status === 503) document.getElementById("login-state").textContent = "Admin login not configured (set ADMIN_PASSWORD).";
    else document.getElementById("login-state").textContent = "Incorrect password.";
  } catch (e) { document.getElementById("login-state").textContent = "Login failed: " + e.message; }
};

document.getElementById("logout-btn").onclick = async () => {
  await fetch("/api/logout", { method: "POST", credentials: "same-origin" });
  showLogin("Logged out.");
};

// --- Data loading ---------------------------------------------------------

async function refreshNations() {
  const nations = await api("GET", "/api/tournament/nations");
  const list = document.getElementById("nation-list");
  list.innerHTML = "";
  for (const n of nations) {
    const li = document.createElement("li");
    li.innerHTML = `<span>${escapeHtml(n.displayName)}</span>`;
    const btn = document.createElement("button");
    btn.textContent = "Remove"; btn.className = "secondary";
    btn.onclick = () => removeNation(n.id);
    li.appendChild(btn);
    list.appendChild(li);
  }
  for (const id of ["match-a", "match-b", "champion"]) {
    const sel = document.getElementById(id);
    const current = sel.value;
    sel.innerHTML = "";
    for (const n of nations) {
      const opt = document.createElement("option");
      opt.value = n.id; opt.textContent = n.displayName;
      sel.appendChild(opt);
    }
    if (current) sel.value = current;
  }
}

async function refreshLeagues() {
  const list = document.getElementById("league-list");
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
    controls.innerHTML = `<input placeholder="Add player name" data-role="pname" style="flex:1 1 10rem" />`;

    const addBtn = document.createElement("button");
    addBtn.textContent = "Add player";
    addBtn.onclick = () => {
      const name = controls.querySelector('[data-role="pname"]').value.trim();
      if (!name) return toast("Enter a player name.", "err");
      run(() => api("POST", `/api/leagues/${encodeURIComponent(lg.slug)}/participants`, { name }), "Player added.");
    };
    const drawBtn = document.createElement("button");
    drawBtn.textContent = lg.assigned ? "Re-draw" : "Run draw"; drawBtn.className = "secondary";
    drawBtn.onclick = () => run(() => api("POST", `/api/leagues/${encodeURIComponent(lg.slug)}/assign`, { confirmReplace: lg.assigned }), "Draw complete.");
    const finBtn = document.createElement("button");
    finBtn.textContent = "Finalize"; finBtn.className = "secondary";
    finBtn.onclick = () => run(() => api("POST", `/api/leagues/${encodeURIComponent(lg.slug)}/finalize`), "League finalized.");
    const copyBtn = document.createElement("button");
    copyBtn.textContent = "Copy link"; copyBtn.className = "secondary";
    copyBtn.onclick = async () => { try { await navigator.clipboard.writeText(link); toast("Link copied.", "ok"); } catch { toast("Copy failed.", "err"); } };
    const teamsBtn = document.createElement("button");
    teamsBtn.textContent = "Teams"; teamsBtn.className = "secondary";
    teamsBtn.onclick = () => toggleTeamPicker(lg, li);
    const delBtn = document.createElement("button");
    delBtn.textContent = "Delete"; delBtn.className = "secondary";
    delBtn.onclick = () => { if (confirm(`Delete league "${lg.name}"? This cannot be undone.`)) run(() => api("DELETE", `/api/leagues/${encodeURIComponent(lg.slug)}`), "League deleted."); };

    controls.appendChild(addBtn); controls.appendChild(drawBtn); controls.appendChild(finBtn); controls.appendChild(teamsBtn); controls.appendChild(copyBtn); controls.appendChild(delBtn);
    li.appendChild(info); li.appendChild(controls);
    if (lg.nationPool !== null) {
      const poolNote = document.createElement("span");
      poolNote.className = "muted";
      poolNote.style.flex = "1 1 100%";
      poolNote.textContent = `Draw pool: ${lg.nationPool} teams (restricted)`;
      li.appendChild(poolNote);
    }
    list.appendChild(li);
  }
}

// --- Fixtures (shared group-stage schedule) ------------------------------

let scheduleCache = null;
function nationIdMap(nations) { const m = new Map(); for (const n of nations) m.set(n.displayName, n.id); return m; }
function pairKey(a, b) { return [a, b].sort().join("|"); }

async function refreshFixtures() {
  const container = document.getElementById("fixtures");
  if (scheduleCache === null) {
    const res = await fetch("/schedule.json", { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error("Could not load the fixture schedule.");
    scheduleCache = await res.json();
  }
  const [nations, matches] = await Promise.all([
    api("GET", "/api/tournament/nations"),
    api("GET", "/api/tournament/matches"),
  ]);
  const idByName = nationIdMap(nations);
  const stored = new Map();
  for (const m of matches) stored.set(pairKey(m.nationAId, m.nationBId), m);

  const filter = document.getElementById("group-filter");
  if (filter.options.length === 0) {
    const groups = [...new Set(scheduleCache.fixtures.map((f) => f.group))].sort();
    filter.innerHTML = `<option value="ALL">All</option>` + groups.map((g) => `<option value="${g}">Group ${g}</option>`).join("");
    filter.onchange = renderFixtures;
  }
  container._data = { idByName, stored };
  renderFixtures();
}

function renderFixtures() {
  const container = document.getElementById("fixtures");
  const data = container._data;
  if (!data) return;
  const { idByName, stored } = data;
  const selected = document.getElementById("group-filter").value || "ALL";
  const fixtures = scheduleCache.fixtures.filter((f) => selected === "ALL" || f.group === selected).sort((a, b) => a.match - b.match);

  container.innerHTML = "";
  const ul = document.createElement("ul");
  ul.className = "pill-list";
  for (const f of fixtures) {
    const aId = idByName.get(f.home);
    const bId = idByName.get(f.away);
    const li = document.createElement("li");
    li.style.flexWrap = "wrap";
    if (!aId || !bId) {
      li.innerHTML = `<span class="muted">${escapeHtml(f.home)} v ${escapeHtml(f.away)} — team not found</span>`;
      ul.appendChild(li); continue;
    }
    const existing = stored.get(pairKey(aId, bId));
    let hg = "", ag = "";
    if (existing) { if (existing.nationAId === aId) { hg = existing.goalsA; ag = existing.goalsB; } else { hg = existing.goalsB; ag = existing.goalsA; } }
    const label = document.createElement("span");
    label.innerHTML = `<strong>${f.group}${existing ? " ✓" : ""}</strong> ${escapeHtml(f.home)} <input type="number" min="0" max="99" style="width:3.5rem" value="${hg}"> – <input type="number" min="0" max="99" style="width:3.5rem" value="${ag}"> ${escapeHtml(f.away)}`;
    const inputs = label.querySelectorAll("input");
    const save = document.createElement("button");
    save.textContent = existing ? "Update" : "Save";
    save.onclick = () => {
      const body = { nationAId: aId, nationBId: bId, goalsA: Number(inputs[0].value), goalsB: Number(inputs[1].value) };
      run(() => api(existing ? "PUT" : "POST", "/api/tournament/matches", body), `Saved ${f.home}–${f.away}.`);
    };
    li.appendChild(label); li.appendChild(save);
    ul.appendChild(li);
  }
  container.appendChild(ul);
}

// --- Actions --------------------------------------------------------------

async function run(action, okMessage) {
  try { await action(); toast(okMessage, "ok"); await refreshAll(); }
  catch (e) { toast(e.message, "err"); }
}

function addNation() {
  const input = document.getElementById("nation-name");
  const name = input.value.trim();
  if (!name) return toast("Enter a name.", "err");
  run(async () => { await api("POST", "/api/tournament/nations", { name }); input.value = ""; allNationsCache = null; }, "Nation added.");
}
function removeNation(id) { run(async () => { await api("DELETE", `/api/tournament/nations/${encodeURIComponent(id)}`); allNationsCache = null; }, "Nation removed."); }
function matchBody() {
  return {
    nationAId: document.getElementById("match-a").value,
    nationBId: document.getElementById("match-b").value,
    goalsA: Number(document.getElementById("goals-a").value),
    goalsB: Number(document.getElementById("goals-b").value),
  };
}

// --- Per-league team picker ----------------------------------------------

let allNationsCache = null;

async function toggleTeamPicker(lg, li) {
  // Toggle: if a picker is already open under this row, close it.
  const existing = li.querySelector('[data-role="team-picker"]');
  if (existing) { existing.remove(); return; }

  if (allNationsCache === null) {
    allNationsCache = await api("GET", "/api/tournament/nations");
  }
  const settings = await api("GET", `/api/leagues/${encodeURIComponent(lg.slug)}/settings`);
  const included = settings.includedNationIds; // null = all
  const isIncluded = (id) => included === null || included.includes(id);

  const box = document.createElement("div");
  box.dataset.role = "team-picker";
  box.style.flex = "1 1 100%";
  box.style.marginTop = "0.5rem";
  box.style.padding = "0.5rem 0.75rem";
  box.style.border = "1px solid var(--line)";
  box.style.borderRadius = "8px";

  if (settings.assigned) {
    box.innerHTML = '<p class="muted">The draw has already run for this league. Teams are locked. Re-draw is allowed, but the team pool can only be changed before any draw.</p>';
    li.appendChild(box);
    return;
  }

  const header = document.createElement("p");
  header.className = "muted";
  header.innerHTML = `Select which teams are eligible for <strong>${escapeHtml(lg.name)}</strong>'s draw. Tip: for a 10-player league, include ~10 teams.`;
  box.appendChild(header);

  const tools = document.createElement("div");
  tools.className = "row";
  const allBtn = document.createElement("button"); allBtn.textContent = "All"; allBtn.className = "secondary";
  const noneBtn = document.createElement("button"); noneBtn.textContent = "None"; noneBtn.className = "secondary";
  const count = document.createElement("span"); count.className = "muted"; count.style.alignSelf = "center";
  tools.appendChild(allBtn); tools.appendChild(noneBtn); tools.appendChild(count);
  box.appendChild(tools);

  const grid = document.createElement("div");
  grid.style.display = "grid";
  grid.style.gridTemplateColumns = "repeat(auto-fill, minmax(11rem, 1fr))";
  grid.style.gap = "0.25rem";
  grid.style.margin = "0.5rem 0";

  const sorted = [...allNationsCache].sort((a, b) => a.displayName.localeCompare(b.displayName));
  for (const n of sorted) {
    const lbl = document.createElement("label");
    lbl.style.fontWeight = "400";
    lbl.style.margin = "0";
    const cb = document.createElement("input");
    cb.type = "checkbox"; cb.value = n.id; cb.checked = isIncluded(n.id);
    cb.style.width = "auto"; cb.style.marginRight = "0.4rem";
    cb.onchange = updateCount;
    lbl.appendChild(cb);
    lbl.appendChild(document.createTextNode(n.displayName));
    grid.appendChild(lbl);
  }
  box.appendChild(grid);

  function checks() { return [...grid.querySelectorAll("input[type=checkbox]")]; }
  function updateCount() { count.textContent = `${checks().filter((c) => c.checked).length} selected`; }
  allBtn.onclick = () => { checks().forEach((c) => (c.checked = true)); updateCount(); };
  noneBtn.onclick = () => { checks().forEach((c) => (c.checked = false)); updateCount(); };
  updateCount();

  const saveRow = document.createElement("div");
  saveRow.className = "row";
  const save = document.createElement("button");
  save.textContent = "Save team pool";
  save.onclick = () => {
    const selected = checks().filter((c) => c.checked).map((c) => c.value);
    if (selected.length === 0) return toast("Select at least one team.", "err");
    // If all teams are selected, store null (= no restriction).
    const nationIds = selected.length === allNationsCache.length ? null : selected;
    run(() => api("PUT", `/api/leagues/${encodeURIComponent(lg.slug)}/nations`, { nationIds }), "Team pool saved.");
  };
  saveRow.appendChild(save);
  box.appendChild(saveRow);

  li.appendChild(box);
}

async function refreshAll() {
  await Promise.all([
    refreshNations().catch((e) => toast(e.message, "err")),
    refreshLeagues().catch((e) => toast(e.message, "err")),
  ]);
  await refreshFixtures().catch((e) => toast(e.message, "err"));
}

// --- Wire up --------------------------------------------------------------

document.getElementById("add-nation").onclick = addNation;
document.getElementById("create-league").onclick = () => {
  const name = document.getElementById("league-name-in").value.trim();
  const password = document.getElementById("league-pass-in").value;
  if (!name) return toast("Enter a league name.", "err");
  run(async () => {
    await api("POST", "/api/leagues", { name, slug: name, password });
    document.getElementById("league-name-in").value = "";
    document.getElementById("league-pass-in").value = "";
  }, "League created.");
};
document.getElementById("record-match").onclick = () => run(() => api("POST", "/api/tournament/matches", matchBody()), "Match recorded.");
document.getElementById("update-match").onclick = () => run(() => api("PUT", "/api/tournament/matches", matchBody()), "Match updated.");
document.getElementById("record-champion").onclick = () => run(() => api("POST", "/api/tournament/champion", { nationId: document.getElementById("champion").value }), "Champion recorded.");

checkSession();
