import { createHash } from "node:crypto";
import type { Box } from "../../shared/events.js";
import type { OCRBarcode } from "../ocr/types.js";
import type { LeakCandidate } from "./types.js";

/** Vision's QR box hugs the modules; a margin also hides the quiet zone a phone camera could still lock onto. */
const MARGIN_FRACTION = 0.08;

const isQr = (barcode: OCRBarcode): boolean => /qr/i.test(barcode.symbology);

function withMargin(box: Box): Box {
  const margin = Math.ceil(Math.max(box.w, box.h) * MARGIN_FRACTION);
  return { x: box.x - margin, y: box.y - margin, w: box.w + 2 * margin, h: box.h + 2 * margin };
}

/** Any QR code (2FA setup, login, payment): masks the whole code. One payload is one leak while it stays on screen. */
export function detectQrCodes(barcodes: readonly OCRBarcode[]): LeakCandidate[] {
  return barcodes.filter(isQr).map((barcode) => ({
    kind: "qr_code",
    box: withMargin(barcode.box),
    preview: "QR code",
    fingerprint: createHash("sha256").update(`qr:${barcode.payload}`).digest("hex"),
  }));
}
