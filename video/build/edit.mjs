// Cuts the demo video from video/footage, video/audio/cedar, video/renders/{cards,sfx,anim-*.mp4} into
// video/renders/twitchy-demo.mp4. Every scene is rendered on its own (picture, narration at fixed offsets, captions in
// sync, sound effects), then the scenes are joined with short transitions.
// Usage: node video/build/edit.mjs [sceneId...]   (no args: all scenes, then the final join)
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const V = fileURLToPath(new URL("../", import.meta.url));
const F = `${V}footage/`, A = `${V}audio/cedar/`, C = `${V}renders/cards/`, R = `${V}renders/`, S = `${V}renders/sfx/`;
const W = 1920, H = 1080, FPS = 30, BG = "0x0e0e10";

// Footage geometry (screen captures are 2940x1912; the Chrome viewport and the Codex app are cropped out of them).
const VOD_CROP = "crop=2880:1428:46:368";
const CODEX_CROP = "crop=2820:1586:120:150";
const fit = `scale=${W}:-2:flags=lanczos,pad=${W}:${H}:0:0:${BG}`; // full width, top aligned: captions sit in the band below
const full = `scale=${W}:${H}:flags=lanczos`;
const norm = `fps=${FPS},format=yuv420p,setsar=1`;
const every = (from, to, n, name, gain) => Array.from({ length: n }, (_, i) => [name, from + ((to - from) * i) / Math.max(1, n - 1), gain]);
const HOOK_CHAT = [1.2, 2.3, 3.4, 4.6, 6.9, 7.4, 7.8, 8.2, 8.6, 9.7, 9.9, 10.1, 10.3, 10.5, 10.7, 10.9, 11.1];

/**
 * Each scene: duration d, narration vo [[clip, start]], overlays [[card, from, to]], sound effects sfx [[name, at, gain, dur?]],
 * ffmpeg inputs, and a picture graph ending in [base]. The transition into the next scene is `next`.
 */
const scenes = {
  hook: {
    d: 27.0, next: "fade",
    vo: [["streamer-0", 0.8], ["streamer-1", 8.6], ["narrator-0", 13.0], ["narrator-1", 16.0], ["narrator-2", 23.6]],
    inputs: [["-i", `${R}anim-hook3d.mp4`]], video: `[0:v]${norm}[base]`, overlays: [],
    sfx: [["hum", 0, .5, 27], ["typing", 1.0, .55, 4.4], ...HOOK_CHAT.map((t) => ["pop", t, .55]), ["glitch", 9.55, .7], ["alarm", 9.85, .5], ["thud", 9.9, .8],
      ["whoosh", 12.9, .7], ["whoosh", 16.6, .6], ["whoosh", 18.4, .6], ["whoosh", 20.2, .6], ...every(18.5, 21.5, 14, "tick", .6), ["ding", 23.6, .8], ["thud", 26.3, .6]],
  },
  intro: {
    d: 13.5, next: "pixelize",
    vo: [["intro-0", 0.4], ["intro-1", 3.7]],
    inputs: [["-i", `${R}anim-intro.mp4`]], video: `[0:v]${norm}[base]`, overlays: [],
    sfx: [["whoosh", 0.15, .5], ["boing", 0.85, .8], ["typing", 1.3, .4, 1.3], ["jump", 6.3, .8], ["thud", 6.95, .35], ["save", 7.0, 1], ["whoosh", 9.7, .4],
      ["jump", 9.75, .7], ["boing", 10.45, .7], ...every(10.6, 11.46, 7, "blip", .8), ["sting", 11.7, 1]],
  },
  montage: {
    d: 21.3, next: "slideleft",
    vo: [["montage-0", 0.3], ["montage-1", 2.5], ["montage-2", 6.4], ["montage-3", 11.0], ["montage-4", 18.6]],
    inputs: [["-ss", "9.4", "-t", "13.9", "-i", `${F}screen-vod.mov`], ["-ss", "23.3", "-t", "25", "-i", `${F}screen-vod.mov`]],
    video: `[0:v]${VOD_CROP},setpts=(PTS-STARTPTS)/1.3,${fit},${norm}[a];[1:v]${VOD_CROP},setpts=(PTS-STARTPTS)/2.6,${fit},${norm}[b];[a][b]concat=n=2:v=1:a=0[base]`,
    overlays: [["tag-twitch", 0, 21.3]],
    sfx: [1.0, 6.0, 10.9, 13.4, 15.9, 18.4].map((t) => ["save", t, .8]),
  },
  rule: {
    d: 15.0, next: "slideleft",
    vo: [["rule-0", 0.3], ["rule-1", 5.1], ["rule-2", 12.0]],
    inputs: existsSync(`${F}dash/`) && readdirSync(`${F}dash/`).length
      ? [["-f", "concat", "-safe", "0", "-i", `${F}dash/list.txt`], ["-ss", "156.8", "-t", "5.6", "-i", `${F}live-broadcast.mov`]]
      : [["-loop", "1", "-t", "9.4", "-i", `${C}tag-dashboard.png`], ["-ss", "156.8", "-t", "5.6", "-i", `${F}live-broadcast.mov`]],
    video: `[0:v]crop=2112:1188:40:330,${full},${norm},trim=duration=9.4,setpts=PTS-STARTPTS[a];[1:v]${full},${norm}[b];[a][b]concat=n=2:v=1:a=0[base]`,
    overlays: [["tag-dashboard", 0, 9.4]],
    sfx: [["typing", 0.2, .5, 3.3], ["click", 3.9, .9], ["save", 5.4, .9], ["whoosh", 9.3, .5], ["save", 10.0, .8]],
  },
  gauntlet: {
    d: 16.0, next: "slideleft",
    vo: [["gauntlet-0", 0.3], ["gauntlet-1", 6.1], ["gauntlet-2", 10.4]],
    inputs: [["-ss", "3", "-t", "82", "-i", `${F}gauntlet.mov`], ["-i", `${R}anim-numbers.mp4`]],
    video: `[0:v]setpts=(PTS-STARTPTS)/8,${full},${norm}[a];[1:v]${norm}[b];[a][b]concat=n=2:v=1:a=0[base]`,
    overlays: [["tag-gauntlet", 0, 10.2]],
    sfx: [...every(0.5, 9.9, 16, "tick", .35), ["thud", 10.2, .7], ...every(10.5, 12.1, 12, "tick", .7), ["save", 12.3, .8], ["save", 13.7, 1]],
  },
  chat: {
    d: 14.9, next: "pixelize",
    vo: [["chat-0", 0.3], ["chat-1", 2.2], ["chat-2", 6.3]],
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
    sfx: [["pop", 0.4, .8], ["pop", 1.6, .8], ["thud", 7.9, .9], ["alarm", 7.9, .45], ["save", 11.9, .9]],
  },
  codex: {
    d: 31.6, next: "fade",
    vo: [["codex-0", 0.3], ["codex-1", 9.0], ["codex-2", 13.3], ["codex-3", 21.3], ["codex-4", 26.9]],
    inputs: [
      ["-i", `${R}anim-pipeline.mp4`],
      ["-ss", "59.5", "-t", "33.5", "-i", `${F}screen-codex.mov`],
      ["-loop", "1", "-t", "2.4", "-i", `${F}gh-commits.png`], ["-loop", "1", "-t", "2.6", "-i", `${F}gh-actions.png`],
    ],
    video: `[0:v]${norm}[a];[1:v]${CODEX_CROP},setpts=(PTS-STARTPTS)/2.43,${full},${norm},trim=duration=13.8,setpts=PTS-STARTPTS[b];`
      + `[2:v]crop=2538:1428:0:0,${full},${norm}[c];[3:v]crop=2538:1428:342:0,${full},${norm}[d];[a][b][c][d]concat=n=4:v=1:a=0[base]`,
    overlays: [["tag-codex", 12.8, 26.6], ["tag-github", 26.6, 31.6]],
    sfx: [...[0.3, 1.2, 2.1, 3.0, 4.0, 4.9].map((t) => ["blip", t, .8]), ...[6.0, 7.0, 8.0, 10.0, 11.0].map((t) => ["tick", t, .7]), ["save", 9.0, .9],
      ["whoosh", 12.7, .5], ["whoosh", 26.5, .5], ["click", 29.0, .6]],
  },
  outro: {
    d: 7.5, next: null,
    vo: [["outro-0", 0.7]],
    inputs: [["-loop", "1", "-t", "7.5", "-i", `${C}outro.png`]],
    video: `[0:v]${full},${norm},fade=in:d=0.4[base]`, overlays: [],
    sfx: [["sting", 0.2, 1], ["save", 5.9, .7]],
  },
};

const ffprobe = (file) => Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]).toString());

function renderScene(id) {
  const s = scenes[id];
  const args = ["-v", "error", "-y"];
  for (const input of s.inputs) args.push(...input);
  let next = s.inputs.length;
  const overlays = [...s.overlays.map(([name, from, to]) => ({ name, from, to }))];
  for (const [clip, start] of s.vo) overlays.push({ name: `cap-${clip}`, from: start, to: Math.min(start + ffprobe(`${A}${clip}.wav`) + 0.25, s.d) });
  let graph = `${s.video};`;
  let last = "base";
  overlays.forEach((o, i) => {
    args.push("-i", `${C}${o.name}.png`);
    graph += `[${next}:v]format=rgba,loop=-1:1:0,setpts=N/${FPS}/TB[o${i}];[${last}][o${i}]overlay=0:0:enable='between(t,${o.from},${o.to})':shortest=0[v${i}];`;
    last = `v${i}`;
    next += 1;
  });
  graph += `[${last}]trim=duration=${s.d},setpts=PTS-STARTPTS[vout];`;
  const tracks = [];
  s.vo.forEach(([clip, start], index) => {
    args.push("-i", `${A}${clip}.wav`);
    graph += `[${next}:a]aresample=48000,aformat=channel_layouts=stereo,adelay=${Math.round(start * 1000)}:all=1[l${index}];`;
    tracks.push(`[l${index}]`);
    next += 1;
  });
  (s.sfx ?? []).forEach(([name, at, gain, dur], index) => {
    args.push("-i", `${S}${name}.wav`);
    const cut = dur ? `atrim=duration=${dur},afade=out:st=${Math.max(0, dur - 0.15)}:d=0.15,` : "";
    graph += `[${next}:a]${cut}volume=${gain},adelay=${Math.round(at * 1000)}:all=1[x${index}];`;
    tracks.push(`[x${index}]`);
    next += 1;
  });
  graph += `${tracks.join("")}amix=inputs=${tracks.length}:normalize=0,apad,atrim=duration=${s.d},aformat=sample_rates=48000:channel_layouts=stereo[aout]`;
  args.push("-filter_complex", graph, "-map", "[vout]", "-map", "[aout]", "-t", String(s.d),
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-r", String(FPS), "-c:a", "pcm_s16le", `${R}seg-${id}.mov`);
  execFileSync("ffmpeg", args, { stdio: "inherit" });
  console.log(`seg-${id}: ${ffprobe(`${R}seg-${id}.mov`).toFixed(2)}s`);
}

/** Joins the scenes with short xfade/acrossfade transitions, then normalizes loudness for YouTube. */
function join(order) {
  const T = 0.35;
  const args = ["-v", "error", "-y"];
  for (const id of order) args.push("-i", `${R}seg-${id}.mov`);
  let graph = "", v = "[0:v]", a = "[0:a]", offset = 0;
  order.slice(1).forEach((id, i) => {
    offset += scenes[order[i]].d - T;
    graph += `${v}[${i + 1}:v]xfade=transition=${scenes[order[i]].next}:duration=${T}:offset=${offset.toFixed(3)}[v${i}];`;
    graph += `${a}[${i + 1}:a]acrossfade=d=${T}[a${i}];`;
    v = `[v${i}]`; a = `[a${i}]`;
  });
  graph += `${a}loudnorm=I=-14:TP=-1.5:LRA=11[aout]`;
  args.push("-filter_complex", graph, "-map", v, "-map", "[aout]", "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-r", String(FPS),
    "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-movflags", "+faststart", `${R}twitchy-demo.mp4`);
  execFileSync("ffmpeg", args, { stdio: "inherit" });
  console.log(`twitchy-demo.mp4: ${ffprobe(`${R}twitchy-demo.mp4`).toFixed(2)}s`);
}

const order = Object.keys(scenes);
const only = process.argv.slice(2);
for (const id of only.length ? only : order) renderScene(id);
if (!only.length) join(order);
