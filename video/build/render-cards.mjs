// Renders every title card, tag and caption to 1920x1080 PNGs (transparent unless the card has a background)
// with headless Chrome, using the dashboard's fonts and colors and the mascot from twitchy.svg.
// Usage: node video/build/render-cards.mjs   → video/renders/cards/*.png
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const out = `${root}video/renders/cards/`;
mkdirSync(out, { recursive: true });
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const sprite = readFileSync(`${root}web/overlay/assets/twitchy.svg`, "utf8").replace("<svg ", '<svg style="display:none" ');
const script = JSON.parse(readFileSync(`${root}video/script.json`, "utf8"));
const fonts = `${root}web/dashboard/fonts/`;
const esc = (text) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;");
const mascot = (pose, size) => `<svg viewBox="0 0 32 32" width="${size}" height="${size}" shape-rendering="crispEdges"><use href="#${pose}"/></svg>`;

const page = (body, background = "transparent") => `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face { font-family: Pixelify; src: url("file://${fonts}PixelifySans-latin-wght.woff2"); font-weight: 400 700; }
@font-face { font-family: Inter; src: url("file://${fonts}Inter-latin-wght.woff2"); font-weight: 100 900; }
* { box-sizing: border-box; margin: 0; }
html, body { width: 1920px; height: 1080px; overflow: hidden; background: ${background}; color: #efeff1; font-family: Inter, sans-serif; }
.center { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; }
.pixel { font-family: Pixelify; }
.caption { position: absolute; left: 50%; bottom: 54px; transform: translateX(-50%); max-width: 1500px; padding: 14px 30px; border-radius: 16px;
  background: rgba(14, 14, 18, .82); font-size: 40px; font-weight: 560; line-height: 1.3; text-align: center; box-shadow: 0 8px 30px #0006; }
.tag { position: absolute; top: 40px; left: 40px; display: flex; align-items: center; gap: 14px; padding: 12px 22px; border-radius: 999px;
  background: rgba(14, 14, 18, .85); border: 2px solid #9146ff; font-size: 30px; font-weight: 650; }
.dot { width: 16px; height: 16px; border-radius: 50%; background: var(--c, #9146ff); }
.purple { color: #a385d9; } .mint { color: #5fe3b5; } .gold { color: #ffcf5c; } .muted { color: #b8b8c2; }
</style></head><body>${sprite}${body}</body></html>`;

const cards = {};
// Captions: one per narration line, so they follow the voice exactly.
for (const scene of script.scenes) scene.lines.forEach((line, index) => {
  cards[`cap-${scene.id}-${index}`] = page(`<div class="caption">${esc(line)}</div>`);
});

const tag = (text, color) => page(`<div class="tag" style="--c:${color};border-color:${color}"><span class="dot"></span>${text}</div>`);
cards["tag-off"] = tag("Shield off", "#d4243f");
cards["tag-on"] = tag("Shield on · same moment", "#5fe3b5");
cards["tag-twitch"] = tag("Recorded live on Twitch", "#9146ff");
cards["tag-dashboard"] = tag("Twitchy dashboard · runs locally", "#9146ff");
cards["tag-gauntlet"] = tag("Leak Gauntlet · real run, sped up", "#ffcf5c");
cards["tag-codex"] = tag("OpenAI Codex · our main build thread", "#5fe3b5");
cards["tag-github"] = tag("github.com/ZakariaShahruri/Codex-x-TwitchCon-Hackathon", "#9146ff");

cards.stamp = page(`<div class="center"><div style="transform: rotate(-8deg); border: 10px solid #ff3355; color: #ff3355; padding: 18px 54px; border-radius: 22px;
  background: rgba(20,0,6,.55); box-shadow: 0 0 80px #ff335555;"><div class="pixel" style="font-size: 150px; font-weight: 700; line-height: 1">AIRED</div>
  <div style="font-size: 38px; font-weight: 700; margin-top: 8px">viewers saw it · it's in the VOD</div></div></div>`);

cards.title = page(`<div class="center" style="gap: 10px">
  ${mascot("armed", 300)}
  <div class="pixel" style="font-size: 150px; font-weight: 700; line-height: 1; margin-top: 10px">Twitchy</div>
  <div style="font-size: 46px; font-weight: 600" class="mint">Stream Shield</div>
  <div style="font-size: 32px; margin-top: 26px" class="muted">Masks secrets on your stream before your viewers see them</div>
</div>`, "radial-gradient(900px 600px at 50% 40%, #2d2140 0%, #1f1f23 70%)");

const stat = (big, small, color) => `<div style="padding: 34px 40px; border-radius: 24px; background: #2b2b31; border: 2px solid #3d3d44; min-width: 400px">
  <div class="pixel" style="font-size: 110px; font-weight: 700; line-height: 1; color: ${color}">${big}</div>
  <div style="font-size: 32px; margin-top: 12px" class="muted">${small}</div></div>`;
cards.numbers = page(`<div class="center" style="gap: 46px">
  <div class="pixel gold" style="font-size: 64px; font-weight: 700">LEAK GAUNTLET · seed 3</div>
  <div style="display: flex; gap: 34px">${stat("37/37", "fake secrets blocked", "#5fe3b5")}${stat("0", "false alarms on 14 lookalikes", "#efeff1")}${stat("3/3", "quick flashes blocked", "#5fe3b5")}</div>
  <div style="font-size: 40px"><b class="mint">311 ms</b> <span class="muted">p95 from screen to mask</span> · <b>1000 ms</b> <span class="muted">stream delay</span> · <b class="mint">every mask up before air</b></div>
</div>`, "#1f1f23");

const box = (title, sub, color = "#3d3d44") => `<div style="width: 300px; padding: 26px 22px; border-radius: 20px; background: #2b2b31; border: 3px solid ${color}">
  <div style="font-size: 34px; font-weight: 700">${title}</div><div style="font-size: 25px; margin-top: 10px" class="muted">${sub}</div></div>`;
const arrow = `<div style="font-size: 56px; color: #9146ff">→</div>`;
cards.pipeline = page(`<div class="center" style="gap: 50px; padding-bottom: 150px">
  <div style="font-size: 54px; font-weight: 700">How Twitchy works</div>
  <div style="display: flex; align-items: center; gap: 22px">
    ${box("OBS frame", "undelayed, every 150 ms")}${arrow}${box("Apple Vision", "on-device text + QR reading")}${arrow}
    ${box("Detectors", "keys · Luhn · BIP39 · watchlist · your rules")}${arrow}${box("Mask", "placed in OBS", "#5fe3b5")}
  </div>
  <div style="display: flex; align-items: center; gap: 22px">${box("1 s stream delay", "masks land inside it", "#ffcf5c")}${arrow}${box("Twitch", "viewers never see it", "#9146ff")}</div>
  <div style="font-size: 32px" class="muted">No frame leaves your Mac · no AI on the live path · $0 to run</div>
</div>`, "#1f1f23");

cards.outro = page(`<div class="center" style="gap: 16px">
  ${mascot("shield", 240)}
  <div class="pixel" style="font-size: 110px; font-weight: 700; line-height: 1.05; margin-top: 8px">Twitchy</div>
  <div style="font-size: 50px; font-weight: 600; max-width: 1400px">Catches leaks before your viewers ever see them.</div>
  <div style="font-size: 32px; margin-top: 30px" class="purple">github.com/ZakariaShahruri/Codex-x-TwitchCon-Hackathon</div>
  <div style="font-size: 26px; margin-top: 6px" class="muted">Built with OpenAI Codex for the Codex x TwitchCon Hackathon · narration is AI-generated</div>
</div>`, "radial-gradient(900px 600px at 50% 40%, #2d2140 0%, #1f1f23 70%)");

for (const [name, html] of Object.entries(cards)) {
  const file = `${out}${name}.html`;
  writeFileSync(file, html);
  execFileSync(CHROME, ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=1", "--window-size=1920,1080",
    "--default-background-color=00000000", "--virtual-time-budget=1500", `--screenshot=${out}${name}.png`, `file://${file}`], { stdio: "ignore" });
}
console.log(`rendered ${Object.keys(cards).length} cards`);
