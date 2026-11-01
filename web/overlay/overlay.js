const CANVAS_WIDTH = 1920;
const CANVAS_HEIGHT = 1080;
const MASCOT_SIZE = 176;
const MASCOT_MARGIN = 36;
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
let running = false;
let reconnectTimer;
let currentPosition = homePosition();

const pause = (duration) => new Promise((resolve) => setTimeout(resolve, duration));

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

function setState(state) {
  const status = ["off", "armed", "degraded", "panic"].includes(state?.status) ? state.status : "off";
  twitchy.dataset.state = status;
  mascotPose.setAttribute("href", `/overlay/assets/twitchy.svg#${status}`);
}

function setCount(value, animate = false) {
  const next = Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
  const changed = next !== totalBlocked;
  totalBlocked = next;
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

function showCover(box) {
  cover.style.left = `${box.x * scaleX}px`;
  cover.style.top = `${box.y * scaleY}px`;
  cover.style.width = `${Math.max(8, box.w * scaleX)}px`;
  cover.style.height = `${Math.max(8, box.h * scaleY)}px`;
  cover.classList.remove("play");
  cover.style.display = "block";
  requestAnimationFrame(() => cover.classList.add("play"));
}

async function actOn(leak) {
  const target = targetFor(leak.box);
  twitchy.dataset.action = "jump";
  place(target.x, target.y);
  await pause(540);
  twitchy.dataset.action = "pull";
  showCover(leak.box);
  await pause(850);
  cover.classList.remove("play");
  cover.style.display = "none";
  twitchy.dataset.action = "jump";
  const home = homePosition();
  place(home.x, home.y);
  await pause(540);
  delete twitchy.dataset.action;
}

async function playQueue() {
  if (running) return;
  running = true;
  while (queue.length) {
    const leak = queue.shift();
    if (leak?.box && ["x", "y", "w", "h"].every((key) => Number.isFinite(leak.box[key]))) {
      await actOn(leak);
    }
  }
  running = false;
}

function handleMessage(message) {
  if (message?.snapshot) {
    setState(message.snapshot.shieldState);
    setCount(message.snapshot.leakCount);
    return;
  }
  if (!message?.event || !message.payload) return;
  if (message.event === "shield.state") setState(message.payload);
  if (message.event === "leak.detected") {
    setCount(message.payload.totalBlocked, true);
    queue.push(message.payload);
    void playQueue();
  }
  // leak.cleared only updates engine state; the on-screen save resolves on its own.
}

function connect() {
  clearTimeout(reconnectTimer);
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(`${scheme}//${location.host}/ws/overlay`);
  socket.addEventListener("open", () => socket.send(JSON.stringify({ role: "overlay" })), { once: true });
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
