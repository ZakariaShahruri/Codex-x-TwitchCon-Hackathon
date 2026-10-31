import type { StartTrack } from "../shared/track.js";

export const start: StartTrack = async () => {
  console.log("track A (shield) ready");
  return async () => {};
};
