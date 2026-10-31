import type { StartTrack } from "../shared/track.js";

export const start: StartTrack = async () => {
  console.log("track B (twitch) ready");
  return async () => {};
};
