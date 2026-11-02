// OBS remote for the video shoot: tsx video/build/obs.mts <command>
//   status | res1080 | res720 | shot [scene] | stage-add | stage-remove | rec-start | rec-stop <name> | stream-start | stream-stop
// rec-stop moves the recording into video/footage/<name>.<ext>. Start times are logged for syncing with screen captures.
import { appendFile, mkdir, rename, writeFile } from "node:fs/promises";
import { extname } from "node:path";
import OBSWebSocket from "obs-websocket-js";
import { loadConfig } from "../../src/shared/config.js";

const config = await loadConfig();
if (!config.env.OBS_WS_URL) throw new Error("OBS_WS_URL is missing from .env");
const obs = new OBSWebSocket();
await obs.connect(config.env.OBS_WS_URL, config.env.OBS_WS_PASSWORD);
const footage = new URL("../footage/", import.meta.url);
await mkdir(footage, { recursive: true });
const log = (line: string) => appendFile(new URL("sync.log", footage), `${new Date().toISOString()} ${line}\n`);
const [command, name] = process.argv.slice(2);
const STAGE = "Video Stage";

try {
  if (command === "status") {
    const [stream, record, video] = await Promise.all([obs.call("GetStreamStatus"), obs.call("GetRecordStatus"), obs.call("GetVideoSettings")]);
    console.log({ streaming: stream.outputActive, recording: record.outputActive, output: `${video.outputWidth}x${video.outputHeight}` });
  } else if (command === "res1080" || command === "res720") {
    const [width, height] = command === "res1080" ? [1920, 1080] : [1280, 720];
    await obs.call("SetVideoSettings", { outputWidth: width, outputHeight: height });
    console.log(`output ${width}x${height}`);
  } else if (command === "rec-start") {
    await obs.call("StartRecord");
    await log("rec-start");
    console.log("recording");
  } else if (command === "rec-stop") {
    if (!name) throw new Error("rec-stop needs a name");
    const { outputPath } = await obs.call("StopRecord");
    await log(`rec-stop ${name}`);
    await new Promise((resolve) => setTimeout(resolve, 1500)); // let OBS finish writing the file
    const target = new URL(`${name}${extname(outputPath)}`, footage);
    await rename(outputPath, target);
    console.log(`saved ${target.pathname}`);
  } else if (command === "shot") {
    const scene = name ?? "Twitchy Broadcast";
    const { imageData } = await obs.call("GetSourceScreenshot", { sourceName: scene, imageFormat: "png", imageWidth: 960 });
    const target = new URL("../renders/obs-shot.png", import.meta.url);
    await writeFile(target, Buffer.from(imageData.split(",")[1]!, "base64"));
    console.log(`saved ${target.pathname}`);
  } else if (command === "stage-add") {
    // The stage page as a full-canvas browser source on top of the content scene, so the desktop never reaches the stream.
    await obs.call("CreateInput", {
      sceneName: "Twitchy Content", inputName: STAGE, inputKind: "browser_source",
      inputSettings: { url: "http://127.0.0.1:4199/", width: 1920, height: 1080, reroute_audio: true, css: "html, body { background: #14161d; }" },
    });
    console.log("stage added");
  } else if (command === "stage-remove") {
    await obs.call("RemoveInput", { inputName: STAGE });
    console.log("stage removed");
  } else if (command === "stream-start") {
    await obs.call("StartStream");
    await log("stream-start");
    console.log("live");
  } else if (command === "stream-stop") {
    await obs.call("StopStream");
    await log("stream-stop");
    console.log("stream stopped");
  } else {
    throw new Error("Unknown command");
  }
} finally {
  await obs.disconnect();
}
