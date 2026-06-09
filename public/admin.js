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
  ]);
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
