import type { StartTrack } from "../shared/track.js";
import { connectContentCapture } from "./capture-loop.js";

export const start: StartTrack = async (_bus, config) => {
  console.log("track A (shield) ready");
  if (!config.env.OBS_WS_URL) {
    console.log("Shield capture idle: set OBS_WS_URL in .env to connect to OBS.");
    return async () => {};
  }

  let stopCapture: (() => Promise<void>) | undefined;
  try {
    stopCapture = await connectContentCapture(config, {
      onFrame: (frame) => {
        if (!frame.unchanged && frame.leaks.length > 0)
          console.log(`Shield detected ${frame.leaks.length} candidate box(es) in Twitchy Content.`);
      },
      onError: (error) => console.error(`Shield capture error: ${error.message}`),
    });
  } catch (error) {
    console.error(`Shield capture unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
  return async () => { await stopCapture?.(); };
};
