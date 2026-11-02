// Cuts the demo video from video/footage + video/audio/cedar + video/renders/cards into video/renders/twitchy-demo.mp4.
// Every scene is rendered on its own (picture, narration lines at fixed offsets, captions in sync), then joined.
// Usage: node video/build/edit.mjs [sceneId...]   (no args: all scenes, then the final join)
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const V = fileURLToPath(new URL("../", import.meta.url));
const F = `${V}footage/`, A = `${V}audio/cedar/`, C = `${V}renders/cards/`, R = `${V}renders/`;
const W = 1920, H = 1080, FPS = 30;
const BG = "0x0e0e10";

// Footage geometry (screen captures are 2940x1912; the Chrome viewport and the Codex app are cropped out of them).
const VOD_CROP = "crop=2880:1428:46:368";
const CODEX_CROP = "crop=2820:1586:120:150";
const fit = `scale=${W}:-2:flags=lanczos,pad=${W}:${H}:0:0:${BG}`; // full width, top aligned: captions sit in the band below
const full = `scale=${W}:${H}:flags=lanczos`;
const norm = `fps=${FPS},format=yuv420p,setsar=1`;

/**
 * Each scene: duration, narration lines (start offsets in s), extra overlays and a picture graph.
 * inputs are ffmpeg input args; video(n) returns the filter chain that ends in [base] using inputs 0..n-1.
 */
const scenes = {
  hook: {
    d: 15.0, vo: [0.5, 3.8, 10.5], sting: null,
    inputs: [["-ss", "41.0", "-t", "2.0", "-i", `${F}live-broadcast.mov`], ["-ss", "90.2", "-t", "4.8", "-i", `${F}live-broadcast.mov`]],
    video: `[0:v]${full},${norm},tpad=stop_mode=clone:stop_duration=8.2[a];[1:v]${full},${norm}[b];[a][b]concat=n=2:v=1:a=0[base]`,
    overlays: [["tag-off", 0, 10.2], ["stamp", 3.2, 10.2], ["tag-on", 10.2, 15.0]],
  },
  intro: {
    d: 10.6, vo: [0.6, 3.8], sting: 0.1,
    inputs: [["-loop", "1", "-t", "10.6", "-i", `${C}title.png`]],
    video: `[0:v]${full},${norm}[base]`, overlays: [],
  },
  montage: {
    d: 21.3, vo: [0.3, 2.5, 6.4, 11.0, 18.6], sting: null,
    inputs: [["-ss", "9.4", "-t", "13.9", "-i", `${F}screen-vod.mov`], ["-ss", "23.3", "-t", "25", "-i", `${F}screen-vod.mov`]],
    video: `[0:v]${VOD_CROP},setpts=(PTS-STARTPTS)/1.3,${fit},${norm}[a];[1:v]${VOD_CROP},setpts=(PTS-STARTPTS)/2.6,${fit},${norm}[b];[a][b]concat=n=2:v=1:a=0[base]`,
    overlays: [["tag-twitch", 0, 21.3]],
  },
  rule: {
    d: 15.0, vo: [0.3, 5.1, 12.0], sting: null,
    inputs: existsSync(`${F}dash/`) && readdirSync(`${F}dash/`).length
      ? [["-f", "concat", "-safe", "0", "-i", `${F}dash/list.txt`], ["-ss", "156.8", "-t", "5.6", "-i", `${F}live-broadcast.mov`]]
      : [["-loop", "1", "-t", "9.4", "-i", `${C}tag-dashboard.png`], ["-ss", "156.8", "-t", "5.6", "-i", `${F}live-broadcast.mov`]],
    video: `[0:v]crop=2112:1188:40:330,${full},${norm},trim=duration=9.4,setpts=PTS-STARTPTS[a];[1:v]${full},${norm}[b];[a][b]concat=n=2:v=1:a=0[base]`,
    overlays: [["tag-dashboard", 0, 9.4]],
  },
  gauntlet: {
    d: 16.0, vo: [0.3, 6.1, 10.4], sting: null,
    inputs: [["-ss", "3", "-t", "82", "-i", `${F}gauntlet.mov`], ["-loop", "1", "-t", "5.8", "-i", `${C}numbers.png`]],
    video: `[0:v]setpts=(PTS-STARTPTS)/8,${full},${norm}[a];[1:v]${full},${norm}[b];[a][b]concat=n=2:v=1:a=0[base]`,
    overlays: [["tag-gauntlet", 0, 10.2]],
  },
  chat: {
    d: 14.9, vo: [0.3, 2.2, 6.3], sting: null,
    inputs: [
      ["-loop", "1", "-t", "5.4", "-i", `${F}vod-0646.png`],
      ["-ss", "432.5", "-t", "5", "-i", `${F}live-broadcast.mov`], ["-loop", "1", "-t", "5", "-i", `${F}vod-0705.png`],
      ["-ss", "450.5", "-t", "4.5", "-i", `${F}live-broadcast.mov`], ["-loop", "1", "-t", "4.5", "-i", `${F}vod-0726.png`],
    ],
    // Panic part: what aired (left) next to the chat replay at that moment (right), laid out like the Twitch page.
    video: `[0:v]${fit},${norm}[a];`
      + `[1:v]scale=1340:754,${norm}[p1];[2:v]crop=680:1090:2200:338,scale=580:930,pad=580:1080:0:0:0x18181b,${norm}[c1];`
      + `[p1]pad=1340:${H}:0:163:${BG}[p1p];[p1p][c1]hstack[b];`
      + `[3:v]scale=1340:754,${norm}[p2];[4:v]crop=680:1090:2200:338,scale=580:930,pad=580:1080:0:0:0x18181b,${norm}[c2];`
      + `[p2]pad=1340:${H}:0:163:${BG}[p2p];[p2p][c2]hstack[c];[a][b][c]concat=n=3:v=1:a=0[base]`,
    overlays: [["tag-twitch", 0, 14.9]],
  },
  codex: {
    d: 31.6, vo: [0.3, 9.0, 13.3, 21.3, 26.9], sting: null,
    inputs: [
      ["-loop", "1", "-t", "12.8", "-i", `${C}pipeline.png`],
      ["-ss", "59.5", "-t", "33.5", "-i", `${F}screen-codex.mov`],
      ["-loop", "1", "-t", "2.4", "-i", `${F}gh-commits.png`], ["-loop", "1", "-t", "2.6", "-i", `${F}gh-actions.png`],
    ],
    video: `[0:v]${full},${norm}[a];[1:v]${CODEX_CROP},setpts=(PTS-STARTPTS)/2.43,${full},${norm},trim=duration=13.8,setpts=PTS-STARTPTS[b];`
      + `[2:v]crop=2538:1428:0:0,${full},${norm}[c];[3:v]crop=2538:1428:342:0,${full},${norm}[d];[a][b][c][d]concat=n=4:v=1:a=0[base]`,
    overlays: [["tag-codex", 12.8, 26.6], ["tag-github", 26.6, 31.6]],
  },
  outro: {
    d: 7.5, vo: [0.7], sting: 0.2,
    inputs: [["-loop", "1", "-t", "7.5", "-i", `${C}outro.png`]],
    video: `[0:v]${full},${norm}[base]`, overlays: [],
  },
};

const STING = "aevalsrc=exprs='0.16*sgn(sin(2*PI*(if(lt(t,0.11),660,990))*t))*exp(-4*t)':d=0.45:s=48000";
const ffprobe = (file) => Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]).toString());

function renderScene(id) {
  const s = scenes[id];
  const args = ["-v", "error", "-y"];
  for (const input of s.inputs) args.push(...input);
  let next = s.inputs.length;
  const overlays = [...s.overlays.map(([name, from, to]) => ({ name, from, to }))];
  s.vo.forEach((start, index) => {
    const len = ffprobe(`${A}${id}-${index}.wav`);
    overlays.push({ name: `cap-${id}-${index}`, from: start, to: Math.min(start + len + 0.25, s.d) });
  });
  let graph = `${s.video};`;
  let last = "base";
  overlays.forEach((o, i) => {
    args.push("-i", `${C}${o.name}.png`);
    const fadeIn = o.name === "stamp" ? `,fade=in:st=${o.from}:d=0.25:alpha=1` : "";
    graph += `[${next}:v]format=rgba,loop=-1:1:0,setpts=N/${FPS}/TB${fadeIn}[o${i}];[${last}][o${i}]overlay=0:0:enable='between(t,${o.from},${o.to})':shortest=0[v${i}];`;
    last = `v${i}`;
    next += 1;
  });
  graph += `[${last}]trim=duration=${s.d},setpts=PTS-STARTPTS[vout];`;
  const voices = [];
  s.vo.forEach((start, index) => {
    args.push("-i", `${A}${id}-${index}.wav`);
    graph += `[${next}:a]aresample=48000,adelay=${Math.round(start * 1000)}:all=1[l${index}];`;
    voices.push(`[l${index}]`);
    next += 1;
  });
  if (s.sting !== null) {
    args.push("-f", "lavfi", "-i", STING);
    graph += `[${next}:a]adelay=${Math.round(s.sting * 1000)}:all=1[st];`;
    voices.push("[st]");
    next += 1;
  }
  graph += `${voices.join("")}amix=inputs=${voices.length}:normalize=0,apad,atrim=duration=${s.d},aformat=sample_rates=48000:channel_layouts=stereo[aout]`;
  args.push("-filter_complex", graph, "-map", "[vout]", "-map", "[aout]", "-t", String(s.d),
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-r", String(FPS), "-c:a", "aac", "-b:a", "192k", `${R}seg-${id}.mp4`);
  execFileSync("ffmpeg", args, { stdio: "inherit" });
  console.log(`seg-${id}: ${ffprobe(`${R}seg-${id}.mp4`).toFixed(2)}s`);
}

const order = Object.keys(scenes);
const only = process.argv.slice(2);
for (const id of only.length ? only : order) renderScene(id);
if (!only.length) {
  writeFileSync(`${R}segments.txt`, order.map((id) => `file '${R}seg-${id}.mp4'`).join("\n"));
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", `${R}segments.txt`,
    "-af", "loudnorm=I=-14:TP=-1.5:LRA=11", "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-r", String(FPS),
    "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", `${R}twitchy-demo.mp4`], { stdio: "inherit" });
  console.log(`twitchy-demo.mp4: ${ffprobe(`${R}twitchy-demo.mp4`).toFixed(2)}s`);
}
