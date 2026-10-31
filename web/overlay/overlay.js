const canvas = document.querySelector("#overlay");
const context = canvas.getContext("2d");
const stateLabel = document.querySelector("#state");
const countLabel = document.querySelector("#count");
const boxes = new Map();
let totalBlocked = 0;

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
  socket.addEventListener("open", () => socket.send(JSON.stringify({ role: "overlay" })));
  socket.addEventListener("message", ({ data }) => {
    let message;
    try { message = JSON.parse(data); } catch { return; }
    if (message.event === "shield.state") stateLabel.textContent = message.payload.status.toUpperCase();
    if (message.event === "leak.detected") {
      totalBlocked = Math.max(totalBlocked, message.payload.totalBlocked);
      countLabel.textContent = `${totalBlocked} leaks blocked`;
      if (message.payload.id !== "replay-count") boxes.set(message.payload.id, message.payload.box);
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
