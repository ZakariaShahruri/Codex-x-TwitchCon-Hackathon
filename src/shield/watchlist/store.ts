import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { WatchlistEntryInput, WatchlistLabel } from "../../shared/events.js";
import { normalizeWatchlistText } from "../detectors/watchlist.js";

export interface WatchlistEntry extends WatchlistEntryInput { id: string }
interface PrivateDocument { watchlist: WatchlistEntry[]; [key: string]: unknown }

function validString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.trim().length <= max;
}

function validateEntries(entries: readonly WatchlistEntry[]): void {
  const ids = new Set<string>();
  for (const entry of entries) {
    if (!validString(entry.id, 128) || !validString(entry.label, 80) || !validString(entry.value, 512))
      throw new Error("Watchlist entries need a valid id, label and value.");
    if (ids.has(entry.id)) throw new Error("Watchlist entry IDs must be unique.");
    ids.add(entry.id);
  }
  for (const entry of entries) {
    const normalizedLabelWords = entry.label.trim().toLocaleLowerCase("en-US").normalize("NFKD")
      .replace(/\p{M}/gu, "").split(/[^\p{L}\p{N}]+/u)
      .map(normalizeWatchlistText).filter(Boolean);
    for (const other of entries) {
      const normalizedValue = normalizeWatchlistText(other.value);
      if (normalizedLabelWords.some((word) => normalizedValue.includes(word)))
        throw new Error("A watchlist label must not reveal any part of a private value.");
    }
  }
}

/** Track A's sole writer for the private watchlist file. */
export class WatchlistStore {
  private queue: Promise<void> = Promise.resolve();

  private constructor(private readonly filePath: string, private document: PrivateDocument) {}

  static async open(filePath = "twitchy.private.json"): Promise<WatchlistStore> {
    let document: PrivateDocument = { watchlist: [] };
    try {
      const parsed: unknown = JSON.parse(await readFile(filePath, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
      const record = parsed as Record<string, unknown>;
      const entries = record.watchlist ?? [];
      if (!Array.isArray(entries) || entries.some((entry) => !entry || typeof entry !== "object" || Array.isArray(entry))) throw new Error();
      const watchlist = entries as WatchlistEntry[];
      validateEntries(watchlist);
      document = { ...record, watchlist };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`Could not load private watchlist file ${filePath}: invalid or unreadable JSON.`);
    }
    return new WatchlistStore(filePath, document);
  }

  get entries(): readonly WatchlistEntry[] { return this.document.watchlist.map((entry) => ({ ...entry })); }
  get labels(): WatchlistLabel[] { return this.document.watchlist.map(({ id, label }) => ({ id, label })); }

  apply(change: { add?: readonly WatchlistEntryInput[]; removeIds?: readonly string[] }): Promise<void> {
    const operation = this.queue.then(async () => {
      const removedIds = new Set(change.removeIds ?? []);
      const retained = this.document.watchlist.filter((entry) => !removedIds.has(entry.id));
      const added = (change.add ?? []).map((entry) => {
        if (!entry || !validString(entry.label, 80) || !validString(entry.value, 512))
          throw new Error("Watchlist additions need a non-empty label (max 80 chars) and value (max 512 chars).");
        return { id: randomUUID(), label: entry.label.trim(), value: entry.value.trim() };
      });
      const watchlist = [...retained, ...added];
      validateEntries(watchlist);
      const next = { ...this.document, watchlist };
      if (JSON.stringify(next) === JSON.stringify(this.document)) return;
      await this.persist(next);
      this.document = next;
    });
    this.queue = operation.catch(() => undefined);
    return operation;
  }

  add(entry: WatchlistEntryInput): Promise<void> { return this.apply({ add: [entry] }); }
  remove(id: string): Promise<void> { return this.apply({ removeIds: [id] }); }
  async flush(): Promise<void> { await this.queue; }

  private async persist(document: PrivateDocument): Promise<void> {
    const folder = dirname(this.filePath);
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
      await chmod(temporary, 0o600);
      await rename(temporary, this.filePath);
      await chmod(this.filePath, 0o600);
    } finally {
      await rm(temporary, { force: true });
    }
  }
}
