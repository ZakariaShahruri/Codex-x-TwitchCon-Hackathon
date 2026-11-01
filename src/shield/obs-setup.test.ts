import test from "node:test";
import assert from "node:assert/strict";
import { broadcastOrder, renderDelayParts } from "./obs-setup.js";

test("splits configured delay into OBS Render Delay filter limits", () => {
  assert.deepEqual(renderDelayParts(500), [500]);
  assert.deepEqual(renderDelayParts(1000), [500, 500]);
  assert.deepEqual(renderDelayParts(1250), [500, 500, 250]);
});

test("stacks Broadcast with content at the bottom, masks above it and the overlay on top", () => {
  assert.deepEqual(broadcastOrder(2), ["Twitchy Raw", "Twitchy Mask 01", "Twitchy Mask 02", "Twitchy Overlay"]);
});
