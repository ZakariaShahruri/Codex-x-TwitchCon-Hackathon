const RECONNECT_MS = 1_000;
const METRICS_STALE_MS = 3_000;
const REQUEST_TIMEOUT_MS = 10_000;
const RULE_TIMEOUT_MS = 15_000;
const MAX_LOG_ROWS = 40;
const $ = (selector) => document.querySelector(selector);
const socketState = { socket: undefined, timer: undefined };
const pendingRequests = new Map();
const leaks = new Map();
let lastMetrics;
let liveState;
let savedPrivateState;
let twitchStatus;
let lastMetricAt = 0;

const timestamp = (value) => new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const shortDuration = (ms) => ms < 1_000 ? `${Math.max(0, Math.round(ms))} ms` : `${(ms / 1_000).toFixed(1)} s`;
const requestId = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

function send(event, payload) {
  if (socketState.socket?.readyState !== WebSocket.OPEN) return false;
  socketState.socket.send(JSON.stringify({ event, payload }));
  return true;
}

function connect() {
  clearTimeout(socketState.timer);
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  let socket;
  try { socket = new WebSocket(`${scheme}//${location.host}/ws/dashboard`); }
  catch {
    setConnection(false);
    socketState.timer = setTimeout(connect, RECONNECT_MS);
    return;
  }
  socketState.socket = socket;
  socket.addEventListener("open", () => setConnection(true));
  socket.addEventListener("message", ({ data }) => {
    try { handleMessage(JSON.parse(data)); } catch { /* Bad frames are ignored; reconnect remains available. */ }
  });
  socket.addEventListener("close", () => {
    setConnection(false);
    socketState.timer = setTimeout(connect, RECONNECT_MS);
  }, { once: true });
  socket.addEventListener("error", () => socket.close(), { once: true });
}

function setConnection(connected) {
  document.body.dataset.connected = String(connected);
  $("#connection-dot").dataset.connected = String(connected);
  $("#connection-label").textContent = connected ? "Connected to local shield" : "Shield disconnected · reconnecting";
  if (!connected) $("#command-feedback").textContent = "Reconnect in progress; commands are temporarily unavailable.";
  else if ($("#command-feedback").textContent.startsWith("Reconnect")) $("#command-feedback").textContent = "Commands go straight to the shield on this machine.";
}

function setShieldState(state) {
  if (!state || !["off", "armed", "degraded", "panic"].includes(state.status)) return;
  const previousStatus = liveState?.status;
  liveState = state;
  const panel = $("#shield-state");
  panel.dataset.state = state.status;
  const labels = { off: "Off duty", armed: "On guard", degraded: "Needs attention", panic: "Panic mask on" };
  $("#status-pose").setAttribute("href", `/overlay/assets/twitchy.svg#${state.status}`);
  $("#header-pose").setAttribute("href", `/overlay/assets/twitchy.svg#${state.status}`);
  $("#dashboard-mascot").dataset.state = state.status;
  document.body.dataset.panic = String(state.status === "panic");
  if (state.status === "panic" && previousStatus !== "panic") {
    document.body.classList.remove("panic-enter");
    void document.body.offsetWidth;
    document.body.classList.add("panic-enter");
    const finishPanicEntry = (event) => {
      if (event.animationName !== "panic-enter") return;
      document.body.classList.remove("panic-enter");
      document.body.removeEventListener("animationend", finishPanicEntry);
    };
    document.body.addEventListener("animationend", finishPanicEntry);
  }
  $("#state-label").textContent = labels[state.status];
  $("#state-reason").textContent = state.reason || ({ off: "Shield is disarmed", armed: "Twitchy is watching your stream", degraded: "A check needs attention", panic: "The full-screen mask is up" }[state.status]);
}

function setTwitchStatus(status, fromSnapshot = false) {
  if (!status || typeof status.connected !== "boolean") return;
  const wasLive = twitchStatus?.live;
  twitchStatus = status;
  const pill = $("#twitch-pill");
  pill.dataset.connected = String(status.connected);
  pill.textContent = status.connected ? "Connected" : "Offline";
  const detail = status.login ? `@${status.login}` : status.error || (status.connected ? "EventSub connected" : "Twitch not connected");
  const expiry = Number.isFinite(status.expiresInHours) ? ` · token ${status.expiresInHours.toFixed(1)} h` : "";
  $("#twitch-detail").textContent = `${detail}${expiry}`;
  $("#hero-twitch").textContent = !status.connected ? "Offline" : status.live === true ? "Live" : "Connected";
  $("#hero-twitch").className = status.connected ? "is-good" : "is-bad";
  if (!fromSnapshot && status.live === true && wasLive !== true) {
    leaks.clear();
    renderLeaks();
    $("#report-content").hidden = true;
    $("#report-hint").textContent = "A private summary appears when Twitch reports the stream offline.";
  }
  if (wasLive === true && status.live === false) showReport();
}

function setPrivateState(state) {
  if (!state || !Array.isArray(state.watchlist) || !Array.isArray(state.rules)) return;
  savedPrivateState = state;
  renderWatchlist();
  renderRules();
}

function renderWatchlist() {
  const list = $("#watchlist-list");
  list.replaceChildren();
  if (!savedPrivateState?.watchlist.length) {
    list.append(emptyRow("No saved labels yet."));
    return;
  }
  for (const entry of savedPrivateState.watchlist) {
    const row = document.createElement("li");
    row.className = "saved-item";
    const label = document.createElement("strong");
    label.textContent = entry.label;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "remove-button";
    remove.textContent = "Remove";
    remove.addEventListener("click", () => {
      if (send("config.updated", { watchlist: { removeIds: [entry.id] } })) $("#watchlist-feedback").textContent = `Removing “${entry.label}”…`;
      else $("#watchlist-feedback").textContent = "Shield disconnected; reconnect before changing the watchlist.";
    });
    row.append(label, remove);
    list.append(row);
  }
}

function emptyRow(text) {
  const row = document.createElement("li");
  row.className = "empty";
  row.textContent = text;
  return row;
}

function setMetrics(metrics) {
  if (!metrics || ![metrics.lastFrameMs, metrics.p95FrameMs, metrics.budgetMs, metrics.framesPerSec, metrics.at].every(Number.isFinite)) return;
  lastMetrics = metrics;
  lastMetricAt = Date.now();
  updateMetrics();
}

function updateMetrics() {
  const health = $("#metric-health");
  const track = $(".latency-track");
  if (!lastMetrics || Date.now() - lastMetricAt >= METRICS_STALE_MS) {
    health.dataset.health = "none";
    health.textContent = "No metrics";
    $("#hero-latency").textContent = "—";
    $("#hero-latency").className = "";
    $("#metric-p95").textContent = "—";
    $("#metric-budget").textContent = "—";
    $("#metric-last").textContent = "—";
    $("#metric-fps").textContent = "—";
    $("#metric-updated").textContent = "No metrics yet · waiting for the shield";
    track.dataset.health = "none";
    $("#latency-fill").style.width = "0%";
    return;
  }
  const { lastFrameMs, p95FrameMs, budgetMs, framesPerSec, at } = lastMetrics;
  const healthLevel = p95FrameMs > budgetMs ? "bad" : p95FrameMs >= budgetMs * .8 ? "warn" : "good";
  health.dataset.health = healthLevel;
  health.textContent = healthLevel === "good" ? "On budget" : healthLevel === "warn" ? "Near budget" : "Over budget";
  track.dataset.health = healthLevel;
  $("#metric-p95").textContent = p95FrameMs.toFixed(1);
  $("#hero-latency").textContent = `${Math.round(p95FrameMs)} ms`;
  $("#hero-latency").className = healthLevel === "bad" ? "is-bad" : "is-good";
  $("#metric-budget").textContent = budgetMs.toFixed(0);
  $("#metric-last").textContent = lastFrameMs.toFixed(1);
  $("#metric-fps").textContent = framesPerSec.toFixed(1);
  $("#metric-updated").textContent = `Updated ${timestamp(at)}`;
  $("#latency-fill").style.width = `${Math.min(100, Math.max(0, budgetMs ? p95FrameMs / budgetMs * 100 : 0))}%`;
}

function renderLeaks(animateId) {
  const list = $("#leak-log");
  list.replaceChildren();
  const rows = [...leaks.values()].slice(-MAX_LOG_ROWS).reverse();
  $("#leak-total").textContent = `${leaks.size} ${leaks.size === 1 ? "save" : "saves"}`;
  $("#hero-saves").textContent = String(leaks.size);
  if (!rows.length) {
    list.append(emptyRow("When Twitchy catches something, it shows up here, redacted."));
    return;
  }
  for (const leak of rows) {
    const row = document.createElement("li");
    row.className = "leak-item";
    row.dataset.active = String(leak.active);
    if (leak.id === animateId) row.classList.add("save-arrival");
    const icon = makePixelIcon(leakPose(leak.kind));
    const desc = document.createElement("span");
    const kind = document.createElement("strong");
    kind.className = "leak-kind";
    kind.textContent = kindLabel(leak.kind);
    const preview = document.createElement("small");
    preview.className = "leak-preview";
    preview.textContent = leak.preview;
    desc.append(kind, preview);
    const meta = document.createElement("small");
    meta.className = "leak-meta";
    meta.textContent = `${timestamp(leak.at)} · ${leak.active ? "Active" : "Cleared"}`;
    row.append(icon, desc, meta);
    list.append(row);
  }
}

function addLeak(payload) {
  if (!payload || typeof payload.id !== "string" || typeof payload.kind !== "string" || typeof payload.preview !== "string" || !Number.isFinite(payload.at)) return;
  leaks.set(payload.id, { id: payload.id, kind: payload.kind, preview: payload.preview, at: payload.at, active: true });
  renderLeaks(payload.id);
}

function clearLeak(payload) {
  const leak = leaks.get(payload?.id);
  if (!leak) return;
  leak.active = false;
  leak.clearedAt = Number.isFinite(payload.at) ? payload.at : Date.now();
  renderLeaks();
}

function showReport() {
  const report = $("#report-content");
  report.replaceChildren();
  report.hidden = false;
  const records = [...leaks.values()];
  const counts = new Map();
  for (const leak of records) counts.set(leak.kind, (counts.get(leak.kind) ?? 0) + 1);
  const title = document.createElement("strong");
  title.className = "report-summary";
  title.textContent = `${records.length} ${records.length === 1 ? "save" : "saves"} this stream`;
  const list = document.createElement("ul");
  list.className = "report-list";
  if (counts.size) {
    for (const [kind, count] of counts) {
      const item = document.createElement("li");
      const icon = makePixelIcon(leakPose(kind));
      const label = document.createElement("span");
      label.textContent = kindLabel(kind);
      const score = document.createElement("strong");
      score.textContent = `${count} ${count === 1 ? "save" : "saves"}`;
      item.append(icon, label, score);
      list.append(item);
    }
  } else list.append(emptyRow("No leaks were recorded in this stream."));
  const first = records.length ? Math.min(...records.map((leak) => leak.at)) : undefined;
  const last = records.length ? Math.max(...records.map((leak) => leak.at)) : undefined;
  const reportTime = Date.now();
  const longest = records.reduce((result, leak) => {
    const duration = Math.max(0, (leak.clearedAt ?? reportTime) - leak.at);
    return duration > (result?.duration ?? -1) ? { leak, duration } : result;
  }, undefined);
  const times = document.createElement("div");
  times.className = "report-times";
  times.textContent = `First save: ${first === undefined ? "—" : timestamp(first)} · Last save: ${last === undefined ? "—" : timestamp(last)} · Longest active: ${longest ? `${kindLabel(longest.leak.kind)} · ${shortDuration(longest.duration)}` : "—"}`;
  report.append(title, list, times);
  report.classList.remove("celebrate");
  void report.offsetWidth;
  report.classList.add("celebrate");
  launchConfetti(report);
  $("#report-hint").textContent = twitchStatus?.live === false ? "Your private stream recap · previews are redacted." : "A little preview of this stream's saves.";
}

const KIND_LABELS = {
  api_key: "API key", email: "Email", password: "Password", phone: "Phone number", card: "Card number", ip: "IP address",
  seed_phrase: "Seed phrase", qr_code: "QR code", watchlist: "Watchlist", custom_rule: "Custom rule", sensitive_region: "Sensitive region",
};
const kindLabel = (kind) => KIND_LABELS[kind] ?? kind.replaceAll("_", " ");

function leakPose(kind) {
  if (["email", "phone"].includes(kind)) return "envelope";
  if (kind === "watchlist" || kind === "ip") return "house";
  if (kind === "qr_code") return "chomp";
  if (["card", "sensitive_region", "seed_phrase"].includes(kind)) return "vault";
  return "shield";
}

function makePixelIcon(pose) {
  const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  icon.setAttribute("viewBox", "0 0 32 32");
  icon.setAttribute("aria-hidden", "true");
  icon.setAttribute("class", "pixel-icon");
  icon.setAttribute("shape-rendering", "crispEdges");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `/overlay/assets/twitchy.svg#${pose}`);
  icon.append(use);
  return icon;
}

function launchConfetti(container) {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const colors = ["mint", "gold", "violet", "pink"];
  for (let index = 0; index < 18; index += 1) {
    const piece = document.createElement("i");
    piece.className = `confetti confetti-${colors[index % colors.length]}`;
    piece.setAttribute("aria-hidden", "true");
    piece.style.setProperty("--confetti-x", `${(index * 37) % 100}%`);
    piece.style.setProperty("--confetti-delay", `${(index % 6) * 45}ms`);
    container.append(piece);
    setTimeout(() => piece.remove(), 1_500);
  }
}

function showSetupResult(result) {
  const request = pendingRequests.get(result?.requestId);
  if (!request || request.kind !== "obs") return;
  clearTimeout(request.timer);
  pendingRequests.delete(result.requestId);
  const lines = result.ok ? (Array.isArray(result.changes) ? result.changes : []) : [result.error || "OBS setup failed."];
  $("#obs-result").textContent = lines.length ? lines.join(" · ") : "OBS is ready; no scene changes were needed.";
}

function showCompiledRule(result) {
  const request = pendingRequests.get(result?.requestId);
  if (!request || request.kind !== "rule") return;
  clearTimeout(request.timer);
  pendingRequests.delete(result.requestId);
  if (!result.ok) {
    $("#rule-feedback").textContent = result.error || "Rule could not be compiled.";
    return;
  }
  const summaries = Array.isArray(result.rules) ? result.rules.map((rule) => rule.description).filter((line) => typeof line === "string") : [];
  $("#rule-feedback").textContent = summaries.length ? `Compiled: ${summaries.join(" · ")}` : "Compiled, but no summary was returned.";
}

function handleMessage(message) {
  if (message?.snapshot) {
    if (message.snapshot.shieldState) setShieldState(message.snapshot.shieldState);
    if (message.snapshot.privateState) setPrivateState(message.snapshot.privateState);
    if (message.snapshot.twitchStatus) setTwitchStatus(message.snapshot.twitchStatus, true);
    return;
  }
  if (!message?.event || !message.payload) return;
  switch (message.event) {
    case "shield.state": setShieldState(message.payload); break;
    case "twitch.status": setTwitchStatus(message.payload); break;
    case "private.state": setPrivateState(message.payload); break;
    case "engine.metrics": setMetrics(message.payload); break;
    case "leak.detected": addLeak(message.payload); break;
    case "leak.cleared": clearLeak(message.payload); break;
    case "obs.setupResult": showSetupResult(message.payload); break;
    case "rules.compiled": showCompiledRule(message.payload); break;
  }
}

document.querySelectorAll("[data-action]").forEach((button) => button.addEventListener("click", () => {
  const action = button.dataset.action;
  if (!["on", "off", "panic", "unblur"].includes(action)) return;
  const mascot = $("#dashboard-mascot");
  const motion = action === "on" ? "motion-hop" : action === "panic" ? "motion-alarm" : action === "unblur" ? "motion-relax" : "";
  if (motion) {
    mascot.classList.remove("motion-hop", "motion-alarm", "motion-relax");
    void mascot.offsetWidth;
    mascot.classList.add(motion);
    mascot.addEventListener("animationend", () => mascot.classList.remove(motion), { once: true });
  }
  $("#command-feedback").textContent = send("shield.command", { action, by: "dashboard", at: Date.now() }) ? `${button.textContent.trim()} sent.` : "Shield disconnected; command not sent.";
}));

$("#obs-setup").addEventListener("click", () => {
  const id = requestId();
  const payload = { requestId: id };
  const scene = $("#content-scene").value.trim();
  if (scene) payload.contentScene = scene;
  if (!send("obs.setup", payload)) { $("#obs-result").textContent = "Shield disconnected; setup request not sent."; return; }
  $("#obs-result").textContent = "Setting up OBS…";
  const timer = setTimeout(() => {
    if (!pendingRequests.delete(id)) return;
    $("#obs-result").textContent = "No answer from the shield yet.";
  }, REQUEST_TIMEOUT_MS);
  pendingRequests.set(id, { kind: "obs", timer });
});

$("#copy-overlay").addEventListener("click", async () => {
  const url = `${location.origin}/overlay/`;
  try {
    await navigator.clipboard.writeText(url);
    $("#copy-overlay").textContent = "Copied!";
  } catch { $("#copy-overlay").textContent = "Copy blocked"; }
  setTimeout(() => { $("#copy-overlay").textContent = "Copy link"; }, 1_500);
});

$("#watchlist-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const labelInput = $("#watchlist-label");
  const valueInput = $("#watchlist-value");
  const label = labelInput.value.trim();
  const value = valueInput.value;
  valueInput.value = "";
  if (!label || !value) { $("#watchlist-feedback").textContent = "Enter both a label and a value."; return; }
  const sent = send("config.updated", { watchlist: { add: [{ label, value }] } });
  $("#watchlist-feedback").textContent = sent ? "Watchlist update sent securely to the shield." : "Shield disconnected; watchlist value cleared without sending.";
  if (sent) {
    const mascot = $("#dashboard-mascot");
    mascot.classList.remove("motion-hop", "motion-alarm", "motion-relax");
    void mascot.offsetWidth;
    mascot.classList.add("motion-hop");
    mascot.addEventListener("animationend", () => mascot.classList.remove("motion-hop"), { once: true });
  }
  if (sent) { labelInput.value = ""; labelInput.focus(); }
});

$("#show-report").addEventListener("click", showReport);

$("#compile-rule").addEventListener("click", () => {
  const text = $("#rule-text").value.trim();
  if (!text) { $("#rule-feedback").textContent = "Describe a rule first."; return; }
  const id = requestId();
  if (!send("rules.compile", { requestId: id, text })) { $("#rule-feedback").textContent = "Shield disconnected; rule not sent."; return; }
  $("#rule-feedback").textContent = "Compiling once…";
  const timer = setTimeout(() => {
    if (!pendingRequests.delete(id)) return;
    $("#rule-feedback").textContent = "Rules compiler not available.";
  }, RULE_TIMEOUT_MS);
  pendingRequests.set(id, { kind: "rule", timer });
});

function renderRules() {
  const list = $("#rule-list");
  list.replaceChildren();
  if (!savedPrivateState?.rules.length) { list.append(emptyRow("No saved rules yet.")); return; }
  for (const rule of savedPrivateState.rules) {
    const row = document.createElement("li");
    row.className = "saved-item";
    const description = document.createElement("strong");
    description.textContent = rule.description;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "remove-button";
    remove.textContent = "Remove";
    remove.addEventListener("click", () => {
      $("#rule-feedback").textContent = send("config.updated", { removedRuleIds: [rule.id] }) ? "Removing saved rule…" : "Shield disconnected; rule not removed.";
    });
    row.append(description, remove);
    list.append(row);
  }
}

$("#overlay-url").textContent = `${location.origin}/overlay/`;
setShieldState({ status: "off" });
setConnection(false);
updateMetrics();
setInterval(updateMetrics, 500);
connect();
