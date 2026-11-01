import type { Box } from "../../shared/events.js";

export interface OCRWord {
  text: string;
  box: Box;
}

/** One recognized Vision text observation, retaining its finer word boxes. */
export interface OCRTextLine {
  text: string;
  box: Box;
  words: OCRWord[];
}

export interface OCRBarcode {
  payload: string;
  symbology: string;
  box: Box;
}

export interface OCRService {
  recognize(png: Uint8Array): Promise<OCRTextLine[]>;
  barcodes(png: Uint8Array): Promise<OCRBarcode[]>;
  close(): Promise<void>;
}
