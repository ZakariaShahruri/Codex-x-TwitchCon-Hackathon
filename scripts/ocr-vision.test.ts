import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { deflateSync } from "node:zlib";

const executable = "tools/ocr-vision/.build/twitchy-ocr";
const supported = process.platform === "darwin" && existsSync(executable);

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, body: Buffer): Buffer {
  const name = Buffer.from(type);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, body])));
  return Buffer.concat([length, name, body, checksum]);
}

function blankPng(width: number, height: number): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  const row = Buffer.alloc(1 + width * 4, 255);
  for (let x = 0; x < width; x += 1) row[1 + x * 4 + 3] = 255;
  const pixels = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header), pngChunk("IDAT", deflateSync(pixels)), pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function framePacket(png: Buffer): Buffer {
  const size = Buffer.alloc(4);
  size.writeUInt32BE(png.length);
  return Buffer.concat([size, png]);
}

test("stdin length-prefixed frames produce one JSON line each", { skip: !supported }, () => {
  const first = blankPng(32, 24);
  const invalid = Buffer.from("not a png");
  for (const level of ["fast", "accurate"]) {
    const result = spawnSync(executable, ["--level", level], {
      input: Buffer.concat([framePacket(first), framePacket(invalid)]),
      maxBuffer: 1024 * 1024,
    });
    assert.equal(result.status, 0, result.stderr.toString());
    const lines = result.stdout.toString("utf8").trim().split("\n");
    assert.equal(lines.length, 2);
    const [validFrame, invalidFrame] = lines.map((line) => JSON.parse(line) as {
      ok: boolean; width: number; height: number; text: unknown[]; barcodes: unknown[]; error?: string;
    });
    assert.equal(validFrame.ok, true);
    assert.equal(validFrame.width, 32);
    assert.equal(validFrame.height, 24);
    assert.ok(Array.isArray(validFrame.text));
    assert.ok(Array.isArray(validFrame.barcodes));
    assert.equal(invalidFrame.ok, false);
    assert.match(invalidFrame.error ?? "", /PNG/i);
  }
});

test("Vision normalized boxes convert to outward-rounded top-left canvas pixels", { skip: !supported }, () => {
  const result = spawnSync(executable, ["--self-test-box"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { x: 50, y: 25, w: 100, h: 50 });
});
