const $ = (id) => document.getElementById(id);
const REFRESH_MS = 10000;
const SEVERITIES = ["critical", "high", "medium", "low"];

let incidents = [];
let selectedId = null;
let severityFilter = "";
let timer = null;

function getSettings() {
  const cfg = window.DASHBOARD_CONFIG || {};
  const base = localStorage.getItem("apiBase") ?? cfg.apiBase ?? "";
  const key = localStorage.getItem("apiKey") ?? cfg.apiKey ?? "";
  return { base: base.trim().replace(/\/+$/, ""), key: key.trim() };
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function statusOf(i) {
  return i.status || "open";
}

function fmt(ts) {
  if (!ts) return "n/a";
  const d = new Date(ts);
  return isNaN(d) ? ts : d.toLocaleString();
}

function badge(severity) {
  return el("span", `badge ${severity || "unknown"}`, severity || "unknown");
}

function showError(msg) {
  const box = $("error");
  box.textContent = msg;
  box.classList.toggle("hidden", !msg);
}

function setConnection(state, text) {
  $("conn").className = `conn ${state}`;
  $("conn-text").textContent = text;
}

async function api(path, options = {}) {
  const { base, key } = getSettings();
  let res;
  try {
    res = await fetch(base + path, {
      ...options,
      headers: { "x-api-key": key, "Content-Type": "application/json", ...(options.headers || {}) },
    });
  } catch (e) {
    throw new Error("Could not reach the API. Check the API base URL and your connection.");
  }
  if (res.status === 403) {
    throw new Error("The API key was rejected (HTTP 403). Update it under API settings.");
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `The API returned HTTP ${res.status}.`);
  }
  return res.json();
}

function render() {
  renderKpis();
  renderMix();
  renderTable();
}

function renderKpis() {
  const count = (fn) => incidents.filter(fn).length;
  $("count-total").textContent = incidents.length;
  $("count-open").textContent = count((i) => statusOf(i) === "open");
  $("count-critical").textContent = count((i) => i.severity === "critical");
  $("count-high").textContent = count((i) => i.severity === "high");
  $("count-checkout").textContent = count((i) => (i.service || "").includes("checkout"));
  $("count-resolved").textContent = count((i) => statusOf(i) === "resolved");
}

function renderMix() {
  const total = incidents.length;
  const stack = $("severity-stack");
  stack.replaceChildren();

  SEVERITIES.forEach((sev) => {
    const n = incidents.filter((i) => i.severity === sev).length;
    $(`legend-${sev}`).textContent = n;
    if (total) {
      const segment = el("span", sev);
      segment.style.width = `${(n / total) * 100}%`;
      segment.title = `${sev}: ${n}`;
      stack.append(segment);
    }
  });

  $("mix-total").textContent = `${total} total`;
}

function matchesFilters(i) {
  const status = $("filter-status").value;
  const q = $("filter-search").value.trim().toLowerCase();
  if (severityFilter && i.severity !== severityFilter) return false;
  if (status && statusOf(i) !== status) return false;
  if (q && !`${i.title} ${i.service}`.toLowerCase().includes(q)) return false;
  return true;
}

function renderTable() {
  const rows = incidents.filter(matchesFilters);
  $("incident-rows").replaceChildren(...rows.map(rowFor));
  $("result-count").textContent = `Showing ${rows.length} of ${incidents.length}`;
  $("empty").classList.toggle("hidden", rows.length > 0);
  $("empty-text").textContent = incidents.length
    ? "Try a different severity, status, or search term."
    : "Trigger a checkout failure in the Mini Shop to see live incidents here.";
}

function rowFor(i) {
  const tr = document.createElement("tr");
  tr.tabIndex = 0;

  const sevCell = el("td");
  sevCell.append(badge(i.severity));

  const titleCell = el("td", "title-cell");
  titleCell.append(
    el("div", "incident-title", i.title || "Untitled"),
    el("div", "incident-source", `via ${i.source || "unknown"}`)
  );

  const statusCell = el("td");
  statusCell.append(el("span", `status-pill status-${statusOf(i)}`, statusOf(i)));

  tr.append(
    sevCell,
    titleCell,
    el("td", "service", i.service || "n/a"),
    statusCell,
    el("td", "seen", String(i.recurrence_count ?? 0)),
    el("td", "time", fmt(i.created_at))
  );

  tr.addEventListener("click", () => openDetail(i.incident_id));
  tr.addEventListener("keydown", (e) => {
    if (e.key === "Enter") openDetail(i.incident_id);
  });
  return tr;
}

function openDetail(id) {
  const i = incidents.find((x) => x.incident_id === id);
  if (!i) return;
  selectedId = id;
  $("d-note").value = i.resolution_note || "";
  $("d-by").value = i.resolved_by || "";
  renderDetail(i);

  $("detail").classList.add("open");
  $("detail").setAttribute("aria-hidden", "false");
  $("overlay").classList.add("open");
}

function refreshDetail() {
  const i = incidents.find((x) => x.incident_id === selectedId);
  if (i) renderDetail(i);
}

function renderDetail(i) {
  const sev = $("d-severity");
  sev.className = `badge ${i.severity || "unknown"}`;
  sev.textContent = i.severity || "unknown";

  const st = $("d-status");
  st.className = `status-pill status-${statusOf(i)}`;
  st.textContent = statusOf(i);

  $("d-title").textContent = i.title || "Untitled";
  $("d-summary").textContent = i.summary || "n/a";
  $("d-cause").textContent = i.probable_root_cause || "n/a";
  $("d-description").textContent = i.description || "n/a";
  $("d-id").textContent = i.incident_id;
  $("d-source").textContent = i.source || "n/a";
  $("d-service").textContent = i.service || "n/a";
  $("d-recurrence").textContent = String(i.recurrence_count ?? 0);
  $("d-created").textContent = fmt(i.created_at);
  $("d-analyzed").textContent = fmt(i.analyzed_at);
  $("d-confidence").textContent = i.confidence || "n/a";

  const resolved = statusOf(i) === "resolved";
  $("d-resolved").textContent = resolved
    ? `${fmt(i.resolved_at)}${i.resolved_by ? ` by ${i.resolved_by}` : ""}`
    : "Not resolved";
  $("d-resolution-hint").textContent = resolved
    ? "Customers following this incident on the Mini Shop can see this note. Edit and mark resolved again to update it."
    : "Describe what fixed the problem. When you mark this resolved, the Mini Shop shows this note to customers.";

  renderSteps(i);
}

function renderSteps(i) {
  const steps = (i.remediation || "").split("\n").map((s) => s.trim()).filter(Boolean);
  const done = new Set(i.completed_steps || []);
  const list = $("d-steps");
  list.replaceChildren(
    ...steps.map((text, n) => {
      const item = el("li");
      const label = el("label", `step${done.has(n) ? " step-done" : ""}`);
      const box = document.createElement("input");
      box.type = "checkbox";
      box.checked = done.has(n);
      box.addEventListener("change", () => toggleStep(n, box.checked));
      label.append(box, el("span", "", text));
      item.append(label);
      return item;
    })
  );
  if (steps.length === 0) list.append(el("li", "empty-note", "No remediation steps were generated."));
}

function toggleStep(n, checked) {
  const i = incidents.find((x) => x.incident_id === selectedId);
  if (!i) return;
  const done = new Set(i.completed_steps || []);
  if (checked) done.add(n);
  else done.delete(n);
  updateIncident({ completed_steps: [...done].sort((a, b) => a - b) });
}

function closeDetail() {
  selectedId = null;
  $("detail").classList.remove("open");
  $("detail").setAttribute("aria-hidden", "true");
  $("overlay").classList.remove("open");
}

async function updateIncident(body) {
  if (!selectedId) return;
  try {
    const updated = await api(`/incidents/${encodeURIComponent(selectedId)}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
    const idx = incidents.findIndex((x) => x.incident_id === selectedId);
    if (idx >= 0) incidents[idx] = updated;
    render();
    showError("");
  } catch (e) {
    showError(e.message);
  }
  refreshDetail();
}

async function setStatus(status) {
  const body = { status };
  if (status === "resolved") {
    const note = $("d-note").value.trim();
    if (!note) {
      showError("Describe what fixed the problem before resolving. Customers will see this note.");
      $("d-note").focus();
      return;
    }
    body.resolution_note = note;
    body.resolved_by = $("d-by").value.trim();
  }
  await updateIncident(body);
}

async function loadPatterns() {
  const list = $("pattern-list");
  try {
    const data = await api("/patterns");
    const items = data.recurring_incidents || [];
    list.replaceChildren();
    if (items.length === 0) {
      list.append(el("li", "empty-note", "No recurring incidents yet."));
      return;
    }
    items.forEach((p) => {
      const li = el("li");
      const head = el("div", "pattern-title");
      head.append(el("span", "", p.title || "Untitled"), el("span", "count-pill", `×${p.occurrences}`));
      li.append(
        head,
        el("div", "pattern-meta", `${p.service || "unknown service"} · ${p.latest_root_cause || "Cause not identified"}`)
      );
      list.append(li);
    });
  } catch (e) {
    /* pattern errors are non-fatal */
  }
}

async function load() {
  const { base, key } = getSettings();
  if (!base || !key) {
    setConnection("idle", "Not configured");
    showError("Add your API base URL and key under API settings to load incidents.");
    return;
  }
  try {
    const data = await api("/incidents");
    incidents = data.incidents || [];
    render();
    $("last-updated").textContent = `Updated ${new Date().toLocaleTimeString()}`;
    setConnection("live", "Live");
    showError("");
    loadPatterns();
    refreshDetail();
  } catch (e) {
    setConnection("offline", "Disconnected");
    showError(e.message);
  }
}

function setupAutoRefresh() {
  clearInterval(timer);
  if ($("auto-refresh").checked) timer = setInterval(load, REFRESH_MS);
}

function openSettings() {
  const { base, key } = getSettings();
  $("api-base").value = base;
  $("api-key").value = key;
  $("settings").classList.remove("hidden");
}

function closeSettings() {
  $("settings").classList.add("hidden");
}

$("save-settings").addEventListener("click", () => {
  localStorage.setItem("apiBase", $("api-base").value.trim());
  localStorage.setItem("apiKey", $("api-key").value.trim());
  closeSettings();
  load();
});
$("reset-settings").addEventListener("click", () => {
  localStorage.removeItem("apiBase");
  localStorage.removeItem("apiKey");
  closeSettings();
  load();
});
$("cancel-settings").addEventListener("click", closeSettings);
$("settings").addEventListener("click", (e) => {
  if (e.target.id === "settings") closeSettings();
});
$("settings-btn").addEventListener("click", openSettings);
$("refresh-btn").addEventListener("click", load);
$("auto-refresh").addEventListener("change", setupAutoRefresh);
$("close-detail").addEventListener("click", closeDetail);
$("overlay").addEventListener("click", closeDetail);
$("filter-status").addEventListener("change", renderTable);
$("filter-search").addEventListener("input", renderTable);
document.querySelectorAll(".chip").forEach((chip) =>
  chip.addEventListener("click", () => {
    severityFilter = chip.dataset.sev;
    document.querySelectorAll(".chip").forEach((c) => c.classList.toggle("active", c === chip));
    renderTable();
  })
);
document.querySelectorAll(".drawer-actions button").forEach((b) =>
  b.addEventListener("click", () => setStatus(b.dataset.set))
);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    closeDetail();
    closeSettings();
  }
});

load();
setupAutoRefresh();
