import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import type { Database as SqlJsDatabase } from "sql.js";

const require = createRequire(import.meta.url);
type InitSqlJs = typeof import("sql.js").default;
const sqlJsModule = require("sql.js") as { default?: InitSqlJs } | InitSqlJs;
const initSqlJs: InitSqlJs = typeof sqlJsModule === "function"
  ? sqlJsModule
  : sqlJsModule.default!;

type SqlJsModule = Awaited<ReturnType<InitSqlJs>>;
type SqlValue = string | number | null | Uint8Array;

let sqlJsPromise: Promise<SqlJsModule> | null = null;

function getSqlJsWasmPath(): string {
  return require.resolve("sql.js/dist/sql-wasm.wasm");
}

async function getSqlJs(): Promise<SqlJsModule> {
  if (!sqlJsPromise) {
    const wasmPath = getSqlJsWasmPath();
    sqlJsPromise = initSqlJs({
      locateFile(file: string): string {
        if (file === "sql-wasm.wasm") {
          return wasmPath;
        }
        return require.resolve(`sql.js/dist/${file}`);
      },
    });
  }
  return sqlJsPromise;
}

export interface ThreadRow {
  thread_id: string;
  file_path: string;
  file_size: number;
  file_mtime: number;
  cwd: string;
  status: "pending" | "processing" | "done" | "error";
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

export class MemoryStorage {
  private db: SqlJsDatabase;
  private dbPath: string;

  private constructor(db: SqlJsDatabase, dbPath: string) {
    this.db = db;
    this.dbPath = dbPath;
  }

  static async create(dbPath: string): Promise<MemoryStorage> {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    const SQL = await getSqlJs();
    const fileBuffer = existsSync(dbPath) ? readFileSync(dbPath) : undefined;
    const db = fileBuffer && fileBuffer.length > 0
      ? new SQL.Database(fileBuffer)
      : new SQL.Database();

    const storage = new MemoryStorage(db, dbPath);
    storage.initSchema();
    return storage;
  }

  private persist(): void {
    const data = this.db.export();
    writeFileSync(this.dbPath, Buffer.from(data));
  }

  private run(sql: string, params: SqlValue[] = []): void {
    this.db.run(sql, params as any);
  }

  private queryAll<T>(sql: string, params: SqlValue[] = []): T[] {
    const stmt = this.db.prepare(sql);
    try {
      stmt.bind(params as any);
      const rows: T[] = [];
      while (stmt.step()) {
        rows.push(stmt.getAsObject() as T);
      }
      return rows;
    } finally {
      stmt.free();
    }
  }

  private queryOne<T>(sql: string, params: SqlValue[] = []): T | undefined {
    return this.queryAll<T>(sql, params)[0];
  }

  private transaction<T>(callback: () => T): T {
    this.run("BEGIN");
    try {
      const result = callback();
      this.run("COMMIT");
      return result;
    } catch (error) {
      try {
        this.run("ROLLBACK");
      } catch {
        // Ignore rollback failures after the original error.
      }
      throw error;
    }
  }

  private initSchema(): void {
    this.run("PRAGMA foreign_keys = ON");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS threads (
        thread_id TEXT PRIMARY KEY,
        file_path TEXT NOT NULL,
        file_size INTEGER NOT NULL DEFAULT 0,
        file_mtime INTEGER NOT NULL DEFAULT 0,
        cwd TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'pending',
        error_message TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS stage1_outputs (
        thread_id TEXT PRIMARY KEY,
        extraction_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (thread_id) REFERENCES threads(thread_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        phase TEXT NOT NULL,
        thread_id TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        worker_id TEXT,
        ownership_token TEXT,
        lease_expires_at TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_jobs_phase_status ON jobs(phase, status);
      CREATE INDEX IF NOT EXISTS idx_threads_status ON threads(status);
      CREATE INDEX IF NOT EXISTS idx_threads_cwd ON threads(cwd);
    `);
    this.persist();
  }

  upsertThreads(
    threads: Array<{
      threadId: string;
      filePath: string;
      fileSize: number;
      fileMtime: number;
      cwd: string;
    }>,
  ): { inserted: number; updated: number; skipped: number } {
    let inserted = 0;
    let updated = 0;
    let skipped = 0;

    this.transaction(() => {
      for (const thread of threads) {
        const existing = this.queryOne<{ file_size: number; file_mtime: number; status: string }>(
          "SELECT file_size, file_mtime, status FROM threads WHERE thread_id = ?",
          [thread.threadId],
        ) as
          | { file_size: number; file_mtime: number; status: string }
          | undefined;

        if (!existing) {
          this.run(
            "INSERT INTO threads (thread_id, file_path, file_size, file_mtime, cwd, status) VALUES (?, ?, ?, ?, ?, 'pending')",
            [
              thread.threadId,
              thread.filePath,
              thread.fileSize,
              thread.fileMtime,
              thread.cwd,
            ],
          );
          this.run(
            "INSERT OR IGNORE INTO jobs (id, phase, thread_id, status) VALUES (?, 'stage1', ?, 'pending')",
            [randomUUID(), thread.threadId],
          );
          inserted += 1;
          continue;
        }

        if (existing.file_size !== thread.fileSize || existing.file_mtime !== thread.fileMtime) {
          this.run(
            "UPDATE threads SET file_path = ?, file_size = ?, file_mtime = ?, cwd = ?, status = 'pending', updated_at = datetime('now') WHERE thread_id = ?",
            [
              thread.filePath,
              thread.fileSize,
              thread.fileMtime,
              thread.cwd,
              thread.threadId,
            ],
          );
          if (existing.status === "done" || existing.status === "error") {
            this.run(
              "INSERT OR IGNORE INTO jobs (id, phase, thread_id, status) VALUES (?, 'stage1', ?, 'pending')",
              [randomUUID(), thread.threadId],
            );
          }
          updated += 1;
          continue;
        }

        skipped += 1;
      }
    });
    this.persist();
    return { inserted, updated, skipped };
  }

  claimStage1Jobs(
    workerId: string,
    limit: number,
    leaseSeconds: number,
  ): Array<{ jobId: string; threadId: string; ownershipToken: string }> {
    const token = randomUUID();
    const expiresAt = new Date(Date.now() + leaseSeconds * 1000).toISOString();
    this.run(
      `UPDATE jobs SET
        status = 'claimed',
        worker_id = ?,
        ownership_token = ?,
        lease_expires_at = ?,
        updated_at = datetime('now')
      WHERE id IN (
        SELECT id FROM jobs
        WHERE phase = 'stage1'
          AND (status = 'pending' OR (status = 'claimed' AND lease_expires_at < datetime('now')))
        LIMIT ?
      )`,
      [workerId, token, expiresAt, limit],
    );
    const rows = this.queryAll<{ id: string; thread_id: string }>(
      "SELECT id, thread_id FROM jobs WHERE ownership_token = ? AND status = 'claimed'",
      [token],
    );
    this.persist();
    return rows.map((row) => ({
      jobId: row.id,
      threadId: row.thread_id,
      ownershipToken: token,
    }));
  }

  completeStage1Job(threadId: string, output: string): void {
    this.transaction(() => {
      this.run(
        "UPDATE jobs SET status = 'done', updated_at = datetime('now') WHERE thread_id = ? AND phase = 'stage1' AND status = 'claimed'",
        [threadId],
      );
      this.run(
        "INSERT OR REPLACE INTO stage1_outputs (thread_id, extraction_json, created_at) VALUES (?, ?, datetime('now'))",
        [threadId, output],
      );
      this.run(
        "UPDATE threads SET status = 'done', updated_at = datetime('now') WHERE thread_id = ?",
        [threadId],
      );
    });
    this.persist();
  }

  failStage1Job(threadId: string, errorMessage: string): void {
    this.transaction(() => {
      this.run(
        "UPDATE jobs SET status = 'error', error_message = ?, updated_at = datetime('now') WHERE thread_id = ? AND phase = 'stage1' AND status = 'claimed'",
        [errorMessage, threadId],
      );
      this.run(
        "UPDATE threads SET status = 'error', error_message = ?, updated_at = datetime('now') WHERE thread_id = ?",
        [errorMessage, threadId],
      );
    });
    this.persist();
  }

  tryClaimGlobalPhase2Job(
    workerId: string,
    leaseSeconds: number,
  ): { jobId: string; ownershipToken: string } | null {
    const token = randomUUID();
    const expiresAt = new Date(Date.now() + leaseSeconds * 1000).toISOString();

    const result = this.transaction(() => {
      const pendingStage1 = this.queryOne<{ cnt: number }>(
        "SELECT COUNT(*) as cnt FROM jobs WHERE phase = 'stage1' AND status IN ('pending', 'claimed')",
      ) as { cnt: number };
      if (pendingStage1.cnt > 0) {
        return null;
      }

      const existingPhase2 = this.queryOne<{ id: string }>(
        "SELECT id FROM jobs WHERE phase = 'stage2' AND status = 'claimed' AND lease_expires_at > datetime('now')",
      );
      if (existingPhase2) {
        return null;
      }

      const outputCount = this.queryOne<{ cnt: number }>(
        "SELECT COUNT(*) as cnt FROM stage1_outputs",
      ) as { cnt: number };
      if (outputCount.cnt === 0) {
        return null;
      }

      const jobId = randomUUID();
      this.run(
        "INSERT INTO jobs (id, phase, status, worker_id, ownership_token, lease_expires_at) VALUES (?, 'stage2', 'claimed', ?, ?, ?)",
        [jobId, workerId, token, expiresAt],
      );
      return { jobId, ownershipToken: token };
    });
    this.persist();
    return result;
  }

  completePhase2Job(jobId: string): void {
    this.run(
      "UPDATE jobs SET status = 'done', updated_at = datetime('now') WHERE id = ? AND phase = 'stage2'",
      [jobId],
    );
    this.persist();
  }

  getStage1OutputsForCwd(cwd: string): Array<{ threadId: string; extractionJson: string }> {
    const rows = this.queryAll<{ thread_id: string; extraction_json: string }>(
      `SELECT s.thread_id, s.extraction_json FROM stage1_outputs s
      INNER JOIN threads t ON t.thread_id = s.thread_id
      WHERE t.cwd = ?`,
      [cwd],
    );

    return rows.map((row) => ({
      threadId: row.thread_id,
      extractionJson: row.extraction_json,
    }));
  }

  getThread(threadId: string): ThreadRow | undefined {
    return this.queryOne<ThreadRow>("SELECT * FROM threads WHERE thread_id = ?", [threadId]) as
      | ThreadRow
      | undefined;
  }

  getStats(): {
    totalThreads: number;
    pendingThreads: number;
    doneThreads: number;
    errorThreads: number;
    totalStage1Outputs: number;
    pendingStage1Jobs: number;
  } {
    const threads = this.queryOne<{
      total: number | null;
      pending: number | null;
      done: number | null;
      errors: number | null;
    }>(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
        SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) as done,
        SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as errors
      FROM threads
    `) as { total: number | null; pending: number | null; done: number | null; errors: number | null };

    const outputs = this.queryOne<{ cnt: number | null }>(
      "SELECT COUNT(*) as cnt FROM stage1_outputs",
    ) as { cnt: number | null };

    const pendingJobs = this.queryOne<{ cnt: number | null }>(
      "SELECT COUNT(*) as cnt FROM jobs WHERE phase = 'stage1' AND status IN ('pending', 'claimed')",
    ) as { cnt: number | null };

    return {
      totalThreads: threads.total ?? 0,
      pendingThreads: threads.pending ?? 0,
      doneThreads: threads.done ?? 0,
      errorThreads: threads.errors ?? 0,
      totalStage1Outputs: outputs.cnt ?? 0,
      pendingStage1Jobs: pendingJobs.cnt ?? 0,
    };
  }

  clearAll(): void {
    this.transaction(() => {
      this.run("DELETE FROM stage1_outputs");
      this.run("DELETE FROM jobs");
      this.run("DELETE FROM threads");
    });
    this.persist();
  }

  clearForCwd(cwd: string): void {
    this.transaction(() => {
      this.run(
        "DELETE FROM stage1_outputs WHERE thread_id IN (SELECT thread_id FROM threads WHERE cwd = ?)",
        [cwd],
      );
      this.run(
        "DELETE FROM jobs WHERE thread_id IN (SELECT thread_id FROM threads WHERE cwd = ?)",
        [cwd],
      );
      this.run("DELETE FROM threads WHERE cwd = ?", [cwd]);
    });
    this.persist();
  }

  resetAllForCwd(cwd: string): void {
    this.transaction(() => {
      this.run(
        "DELETE FROM stage1_outputs WHERE thread_id IN (SELECT thread_id FROM threads WHERE cwd = ?)",
        [cwd],
      );
      this.run(
        "DELETE FROM jobs WHERE thread_id IN (SELECT thread_id FROM threads WHERE cwd = ?)",
        [cwd],
      );
      this.run(
        "UPDATE threads SET status = 'pending', updated_at = datetime('now') WHERE cwd = ?",
        [cwd],
      );

      const threads = this.queryAll<{ thread_id: string }>(
        "SELECT thread_id FROM threads WHERE cwd = ?",
        [cwd],
      );
      for (const thread of threads) {
        this.run(
          "INSERT INTO jobs (id, phase, thread_id, status) VALUES (?, 'stage1', ?, 'pending')",
          [randomUUID(), thread.thread_id],
        );
      }
    });
    this.persist();
  }

  close(): void {
    this.persist();
    this.db.close();
  }
}
