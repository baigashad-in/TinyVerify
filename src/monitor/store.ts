import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { VerifiedRecord } from "../types.js";
import type { ChangeEvent } from "./diff.js";

export interface Watch {
  id: string;
  created_at: string;
  state: "active" | "deleted";
  monitor_id: string;
  registry_id: string;
  identifier: string | null;
  subject_name: string | null;
  record_url: string;
  schedule_cron: string;
  webhook_enabled: boolean;
  callback_url: string | null;
  /** Did TinyFish Monitor's own Fetch baseline parse into the same record? */
  monitor_baseline_readable: boolean;
  baseline: VerifiedRecord;
  latest: VerifiedRecord;
  last_checked_at: string;
  last_unreadable_at: string | null;
  last_stable_hash: string | null;
  processed_run_ids: string[];
  /**
   * Last record read by each method (parser on the Monitor page, or Agent).
   * Actions and flags are diffed only against a read of the same kind.
   * Optional so store files written before this field existed still load.
   */
  latest_by_extraction?: Partial<Record<VerifiedRecord["source"]["extraction"], VerifiedRecord>>;
  /** Scheduled runs in a row where the Agent read was skipped because the page had not changed. */
  agent_skips?: number;
}

interface StoreData {
  version: 1;
  watches: Record<string, Watch>;
  events: ChangeEvent[];
}

export interface Store {
  getWatch(id: string): Promise<Watch | undefined>;
  findByMonitor(monitorId: string): Promise<Watch | undefined>;
  listWatches(): Promise<Watch[]>;
  saveWatch(w: Watch): Promise<void>;
  addEvents(events: ChangeEvent[]): Promise<void>;
  listEvents(filter?: { watchId?: string; since?: string }): Promise<ChangeEvent[]>;
}

/** Keeps everything in memory. Used by tests and short demos. */
export class MemoryStore implements Store {
  protected data: StoreData = { version: 1, watches: {}, events: [] };

  async getWatch(id: string) {
    return this.data.watches[id];
  }
  async findByMonitor(monitorId: string) {
    return Object.values(this.data.watches).find((w) => w.monitor_id === monitorId && w.state === "active");
  }
  async listWatches() {
    return Object.values(this.data.watches).sort((a, b) => a.created_at.localeCompare(b.created_at));
  }
  async saveWatch(w: Watch) {
    this.data.watches[w.id] = w;
    await this.persist();
  }
  async addEvents(events: ChangeEvent[]) {
    if (events.length === 0) return;
    this.data.events.push(...events);
    if (this.data.events.length > 5000) this.data.events = this.data.events.slice(-5000);
    await this.persist();
  }
  async listEvents(filter: { watchId?: string; since?: string } = {}) {
    return this.data.events.filter(
      (e) => (!filter.watchId || e.watch_id === filter.watchId) && (!filter.since || e.detected_at > filter.since),
    );
  }
  protected async persist(): Promise<void> {}
}

/** JSON file on disk. No native modules, so it runs anywhere Node runs. */
export class FileStore extends MemoryStore {
  private loaded = false;
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {
    super();
  }

  async load(): Promise<this> {
    if (this.loaded) return this;
    try {
      const raw = await readFile(this.path, "utf8");
      const parsed = JSON.parse(raw) as StoreData;
      if (parsed && parsed.version === 1) this.data = parsed;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    this.loaded = true;
    return this;
  }

  protected override async persist(): Promise<void> {
    const snapshot = JSON.stringify(this.data, null, 2);
    // Serialize writes and replace the file atomically.
    this.writing = this.writing.then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp`;
      await writeFile(tmp, snapshot, "utf8");
      await rename(tmp, this.path);
    });
    return this.writing;
  }
}
