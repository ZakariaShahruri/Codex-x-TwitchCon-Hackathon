import type { GauntletCase } from "./cases.js";
import { flashCases, gauntletCases } from "./cases.js";

export interface PlannedCase {
  id: string;
  kind: GauntletCase["kind"];
  context: string;
  displayText: string;
  label: string;
  x: number;
  y: number;
  width: number;
  fontPx: number;
  theme: "light" | "dark";
  style: "terminal" | "editor" | "json" | "dm";
  visibleMs: number;
  holdMs: number;
  flash: boolean;
}

function randomFrom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = state;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4_294_967_296;
  };
}

export function createGauntletPlan(seed: number, holdMs: number): PlannedCase[] {
  const random = randomFrom(seed);
  const shuffle = <T>(values: readonly T[]): T[] => {
    const result = [...values];
    for (let index = result.length - 1; index > 0; index -= 1) {
      const other = Math.floor(random() * (index + 1));
      [result[index], result[other]] = [result[other]!, result[index]!];
    }
    return result;
  };
  const secrets = shuffle(gauntletCases.filter((item) => item.kind !== null));
  const decoys = shuffle(gauntletCases.filter((item) => item.kind === null));
  const flashes = shuffle(flashCases);
  const sequence = [
    ...secrets.map((item, index) => ({ item, label: `round ${index + 1}/${secrets.length}`, flash: false })),
    ...decoys.map((item, index) => ({ item, label: `decoy ${index + 1}/${decoys.length}`, flash: false })),
    ...flashes.map((item, index) => ({ item, label: `flash ${index + 1}/${flashes.length}`, flash: true })),
  ];
  const styles = ["terminal", "editor", "json", "dm"] as const;
  return sequence.map(({ item, label, flash }, index) => {
    const width = 55 + Math.round(random() * 27);
    return {
      id: item.id,
      kind: item.kind,
      context: `${["Terminal · zsh", "Editor · .env", "Browser · settings.json", "Direct message · friend"][index % 4]} · ${item.context}`,
      displayText: styles[index % styles.length] === "terminal" ? `$ ${item.text}` : item.text,
      label,
      width,
      x: 2 + Math.round(random() * (96 - width - 2)),
      y: 12 + Math.round(random() * 68),
      fontPx: 12 + Math.floor(random() * 7),
      theme: random() < 0.5 ? "light" : "dark",
      style: styles[index % styles.length],
      visibleMs: flash ? 250 + Math.floor(random() * 351) : item.kind === null ? 350 : 650,
      holdMs: item.kind === null ? 0 : holdMs,
      flash,
    };
  });
}
