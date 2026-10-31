import test from "node:test";
import assert from "node:assert/strict";
import { renderDelayParts } from "./obs-setup.js";

test("splits configured delay into OBS Render Delay filter limits", () => {
  assert.deepEqual(renderDelayParts(500), [500]);
  assert.deepEqual(renderDelayParts(1000), [500, 500]);
  assert.deepEqual(renderDelayParts(1250), [500, 500, 250]);
});
