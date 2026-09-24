/**
 * Minimal in-process background-job runner with JSON persistence.
 *
 * Long tasks (e.g. building + listing 96 products) blow past the MCP transport's
 * ~90s timeout, so the tool starts a job, returns a jobId immediately, and the
 * work continues in this (long-lived) Node process. A later ebay_job_status call
 * reads the shared state. State is mirrored to `{stateDir}/jobs/<jobId>.json` so a
 * status check survives across requests and a crash leaves an inspectable record.
 *
 * Not a distributed queue — one process, best-effort durability. A job still
 * "running" when the process restarts is marked `interrupted` on next load.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { log } from "./logger.js";

export type JobStatus = "running" | "done" | "error" | "interrupted";

export interface JobState {
  jobId: string;
  kind: string;
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  progress: Record<string, unknown>;
  result?: unknown;
  error?: string;
}

/** Passed to a job's work function to publish incremental progress. */
export type ProgressFn = (progress: Record<string, unknown>) => void;

export class JobRunner {
  private readonly dir: string;
  private readonly jobs = new Map<string, JobState>();

  constructor(stateDir: string) {
    this.dir = join(stateDir, "jobs");
    try { if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true }); } catch { /* best-effort */ }
    // Reload prior jobs; anything left "running" died with a previous process.
    try {
      for (const f of readdirSync(this.dir)) {
        if (!f.endsWith(".json")) continue;
        try {
          const s = JSON.parse(readFileSync(join(this.dir, f), "utf8")) as JobState;
          if (s.status === "running") { s.status = "interrupted"; }
          this.jobs.set(s.jobId, s);
        } catch { /* skip unreadable */ }
      }
    } catch { /* dir unreadable — start empty */ }
  }

  private persist(s: JobState): void {
    this.jobs.set(s.jobId, s);
    try {
      const file = join(this.dir, `${s.jobId}.json`);
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, JSON.stringify(s, null, 2));
      renameSync(tmp, file);
    } catch (e) { log.error("job_persist_failed", { jobId: s.jobId, error: e instanceof Error ? e.message : String(e) }); }
  }

  /** Start a job. Returns its state immediately; the work runs detached. */
  start(kind: string, work: (progress: ProgressFn) => Promise<unknown>): JobState {
    const jobId = `${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
    const now = new Date().toISOString();
    const state: JobState = { jobId, kind, status: "running", createdAt: now, updatedAt: now, progress: {} };
    this.persist(state);
    const update: ProgressFn = (progress) => {
      const cur = this.jobs.get(jobId);
      if (!cur || cur.status !== "running") return;
      cur.progress = { ...cur.progress, ...progress };
      cur.updatedAt = new Date().toISOString();
      this.persist(cur);
    };
    void (async () => {
      try {
        const result = await work(update);
        const cur = this.jobs.get(jobId)!;
        cur.status = "done"; cur.result = result; cur.updatedAt = new Date().toISOString();
        this.persist(cur);
        log.info("job_done", { jobId, kind });
      } catch (e) {
        const cur = this.jobs.get(jobId)!;
        cur.status = "error"; cur.error = e instanceof Error ? e.message : String(e); cur.updatedAt = new Date().toISOString();
        this.persist(cur);
        log.error("job_failed", { jobId, kind, error: cur.error });
      }
    })();
    return state;
  }

  get(jobId: string): JobState | null { return this.jobs.get(jobId) ?? null; }
}
