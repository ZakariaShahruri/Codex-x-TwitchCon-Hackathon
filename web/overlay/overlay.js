const CANVAS_WIDTH = 1920;
const CANVAS_HEIGHT = 1080;
const MASCOT_SIZE = 176;
const MASCOT_MARGIN = 36;
const MAX_PENDING_SAVES = 2;
const SPRITE_URL = "/overlay/assets/twitchy.svg";
const REACTIONS = {
  shield: { kinds: ["api_key", "password", "custom_rule"], duration: 500, quick: 170, label: "BASH!" },
  envelope: { kinds: ["email", "phone"], duration: 620, quick: 180, label: "ZIPP!" },
  house: { kinds: ["watchlist", "ip"], duration: 620, quick: 180, label: "HIDE!" },
  chomp: { kinds: ["qr_code"], duration: 560, quick: 170, label: "NOM!" },
  vault: { kinds: ["card", "seed_phrase", "sensitive_region"], duration: 620, quick: 180, label: "SAFE!" },
  generic: { kinds: [], duration: 300, quick: 140, label: "BLOCKED!" },
};
const REACTION_BY_KIND = new Map(Object.entries(REACTIONS).flatMap(([name, reaction]) => reaction.kinds.map((kind) => [kind, name])));
const stage = document.querySelector("#stage");
const twitchy = document.querySelector("#twitchy");
const mascotPose = document.querySelector("#mascot-pose");
const counter = document.querySelector("#counter");
const countNode = document.querySelector("#count");
const cover = document.querySelector("#cover");
const queue = [];
let scaleX = 1;
let scaleY = 1;
let uiScale = 1;
let totalBlocked = 0;
let latestLeakCount = 0;
let stateStatus = "off";
let running = false;
let runVersion = 0;
let reconnectTimer;
let wakePause;
let currentPosition = homePosition();

function pause(duration) {
  return new Promise((resolve) => {
    const timer = setTimeout(done, duration);
    function done() {
      clearTimeout(timer);
      if (wakePause === done) wakePause = undefined;
      resolve();
    }
    wakePause = done;
  });
}

function homePosition() {
  return { x: CANVAS_WIDTH - MASCOT_SIZE - MASCOT_MARGIN, y: CANVAS_HEIGHT - MASCOT_SIZE - MASCOT_MARGIN };
}

function place(x, y) {
  currentPosition = { x, y };
  twitchy.style.setProperty("--x", `${Math.round(x * scaleX)}px`);
  twitchy.style.setProperty("--y", `${Math.round(y * scaleY)}px`);
}

function resize() {
  scaleX = innerWidth / CANVAS_WIDTH;
  scaleY = innerHeight / CANVAS_HEIGHT;
  uiScale = Math.min(scaleX, scaleY);
  stage.style.setProperty("--scale", String(uiScale));
  place(currentPosition.x, currentPosition.y);
}

function sendHomeAndClearQueue() {
  runVersion += 1;
  queue.length = 0;
  wakePause?.();
  cover.classList.remove("play");
  cover.style.display = "none";
  setAction();
  twitchy.style.setProperty("--travel-duration", "320ms");
  const home = homePosition();
  place(home.x, home.y);
  setCount(latestLeakCount);
}

function resetToSnapshot() {
  runVersion += 1;
  queue.length = 0;
  wakePause?.();
  cover.classList.remove("play");
  cover.style.display = "none";
  setAction();
  twitchy.classList.remove("ready");
  const home = homePosition();
  place(home.x, home.y);
  requestAnimationFrame(() => twitchy.classList.add("ready"));
}

function setState(state) {
  const status = ["off", "armed", "degraded", "panic"].includes(state?.status) ? state.status : "off";
  stateStatus = status;
  stage.dataset.state = status;
  twitchy.dataset.state = status;
  if (!twitchy.dataset.action) mascotPose.setAttribute("href", `${SPRITE_URL}#${status}`);
  if (status === "panic" || status === "off") sendHomeAndClearQueue();
}

function setAction(action, duration) {
  if (action) twitchy.dataset.action = action;
  else delete twitchy.dataset.action;
  if (duration) twitchy.style.setProperty("--action-duration", `${duration}ms`);
  else twitchy.style.removeProperty("--action-duration");
  const pose = action && ["shield", "envelope", "house", "chomp", "vault"].includes(action) ? action : stateStatus;
  mascotPose.setAttribute("href", `${SPRITE_URL}#${pose}`);
}

function setCount(value, animate = false, exact = false) {
  const next = Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
  if (exact) counter.getAnimations().forEach((animation) => animation.cancel());
  const shown = exact ? next : Math.max(totalBlocked, next);
  const changed = shown !== totalBlocked;
  totalBlocked = shown;
  countNode.textContent = String(totalBlocked);
  if (animate && changed) {
    counter.animate(
      [{ transform: "scale(1)" }, { transform: "scale(1.105)", offset: .42 }, { transform: "scale(.98)", offset: .72 }, { transform: "scale(1)" }],
      { duration: 380, easing: "steps(4, end)" },
    );
  }
}

function targetFor(box) {
  const centerX = box.x + box.w / 2;
  const left = centerX - MASCOT_SIZE / 2;
  const above = box.y - MASCOT_SIZE - 24;
  const below = box.y + box.h + 24;
  const top = above >= MASCOT_MARGIN ? above : below;
  return {
    x: Math.max(MASCOT_MARGIN, Math.min(CANVAS_WIDTH - MASCOT_SIZE - MASCOT_MARGIN, left)),
    y: Math.max(MASCOT_MARGIN, Math.min(CANVAS_HEIGHT - MASCOT_SIZE - MASCOT_MARGIN, top)),
  };
}

function showCover(box, reaction, duration) {
  cover.style.left = `${box.x * scaleX}px`;
  cover.style.top = `${box.y * scaleY}px`;
  cover.style.width = `${Math.max(8, box.w * scaleX)}px`;
  cover.style.height = `${Math.max(8, box.h * scaleY)}px`;
  cover.style.setProperty("--cover-duration", `${duration}ms`);
  cover.dataset.reaction = reaction;
  cover.querySelector(".cover-label").textContent = REACTIONS[reaction].label;
  cover.classList.remove("play");
  cover.style.display = "block";
  requestAnimationFrame(() => cover.classList.add("play"));
}

async function actOn(leak, version, chained) {
  const target = targetFor(leak.box);
  const travelDuration = chained ? 220 : 360;
  twitchy.style.setProperty("--travel-duration", `${travelDuration}ms`);
  setAction("jump", travelDuration);
  place(target.x, target.y);
  await pause(travelDuration);
  if (version !== runVersion) return;
  setCount(leak.totalBlocked, true);
  const reaction = REACTION_BY_KIND.get(leak.kind) ?? "generic";
  const spec = REACTIONS[reaction];
  const quickSave = chained || queue.length > 0;
  const reactionDuration = quickSave ? spec.quick : spec.duration;
  setAction(reaction, reactionDuration);
  showCover(leak.box, reaction, reactionDuration);
  await pause(reactionDuration + 20);
  if (version !== runVersion) return;
  cover.classList.remove("play");
  cover.style.display = "none";
  if (queue.length > 0) return;
  setAction("jump", 320);
  const home = homePosition();
  twitchy.style.setProperty("--travel-duration", "320ms");
  place(home.x, home.y);
  await pause(320);
  if (version !== runVersion) return;
  setAction();
}

async function playQueue() {
  if (running) return;
  running = true;
  const version = runVersion;
  let chained = false;
  try {
    while (queue.length && version === runVersion) {
      const leak = queue.shift();
      if (leak?.box && ["x", "y", "w", "h"].every((key) => Number.isFinite(leak.box[key]))) {
        await actOn(leak, version, chained);
        if (version !== runVersion) break;
      }
      chained = queue.length > 0;
    }
  } finally {
    running = false;
    if (queue.length) void playQueue();
  }
}

function handleMessage(message) {
  if (message?.snapshot) {
    resetToSnapshot();
    latestLeakCount = Number.isFinite(message.snapshot.leakCount) ? Math.max(0, Math.floor(message.snapshot.leakCount)) : 0;
    setCount(latestLeakCount, false, true);
    setState(message.snapshot.shieldState);
    return;
  }
  if (!message?.event || !message.payload) return;
  if (message.event === "shield.state") setState(message.payload);
  if (message.event === "leak.detected") {
    latestLeakCount = Math.max(latestLeakCount, message.payload.totalBlocked);
    if (stateStatus === "panic" || stateStatus === "off") {
      setCount(latestLeakCount);
      return;
    }
    queue.push(message.payload);
    while (queue.length > MAX_PENDING_SAVES) queue.shift();
    void playQueue();
  }
  // leak.cleared only updates engine state; the on-screen save resolves on its own.
}

function connect() {
  clearTimeout(reconnectTimer);
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  let socket;
  try { socket = new WebSocket(`${scheme}//${location.host}/ws/overlay`); }
  catch {
    reconnectTimer = setTimeout(connect, 1000);
    return;
  }
  socket.addEventListener("message", ({ data }) => {
    try { handleMessage(JSON.parse(data)); } catch { /* Ignore malformed frames and keep the overlay alive. */ }
  });
  socket.addEventListener("close", () => { reconnectTimer = setTimeout(connect, 1000); }, { once: true });
  socket.addEventListener("error", () => socket.close(), { once: true });
}

window.addEventListener("resize", resize, { passive: true });
resize();
twitchy.dataset.state = "off";
requestAnimationFrame(() => twitchy.classList.add("ready"));
connect();
