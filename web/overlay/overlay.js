const canvas = document.querySelector("#overlay");
const context = canvas.getContext("2d");
const stateLabel = document.querySelector("#state");
const countLabel = document.querySelector("#count");
const boxes = new Map();
let totalBlocked = 0;

function showState(state) {
  stateLabel.textContent = state.status.toUpperCase();
}
function showCount(count) {
  totalBlocked = Math.max(totalBlocked, count);
  countLabel.textContent = `${totalBlocked} leaks blocked`;
}

function resize() {
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.round(innerWidth * ratio);
  canvas.height = Math.round(innerHeight * ratio);
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  draw();
}
function draw() {
  context.clearRect(0, 0, innerWidth, innerHeight);
  context.lineWidth = 3;
  context.strokeStyle = "#ff3158";
  context.shadowColor = "#ff3158";
  context.shadowBlur = 14;
  for (const box of boxes.values()) context.strokeRect(box.x, box.y, box.w, box.h);
  context.shadowBlur = 0;
}
function connect() {
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(`${scheme}//${location.host}/ws/overlay`);
  socket.addEventListener("message", ({ data }) => {
    let message;
    try { message = JSON.parse(data); } catch { return; }
    if (message.snapshot) {
      if (message.snapshot.shieldState) showState(message.snapshot.shieldState);
      showCount(message.snapshot.leakCount);
      return;
    }
    if (message.event === "shield.state") showState(message.payload);
    if (message.event === "leak.detected") {
      showCount(message.payload.totalBlocked);
      boxes.set(message.payload.id, message.payload.box);
      draw();
    }
    if (message.event === "leak.cleared") { boxes.delete(message.payload.id); draw(); }
  });
  socket.addEventListener("close", () => { stateLabel.textContent = "RECONNECTING"; setTimeout(connect, 1000); }, { once: true });
  socket.addEventListener("error", () => socket.close(), { once: true });
}
window.addEventListener("resize", resize);
resize();
connect();
