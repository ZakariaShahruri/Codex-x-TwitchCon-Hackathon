import type { StartTrack } from "../shared/track.js";
import { createEventSubTrack } from "./client.js";

export const start: StartTrack = createEventSubTrack();
