import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { dataPaths, ensureDataDirs } from './paths';
import {
  DEFAULT_APP_SETTINGS,
  DEFAULT_JOB_SETTINGS,
  type AppSettings,
  type Clip,
  type ClipStatus,
  type Favorite,
  type Job,
  type JobLog,
  type JobResult,
  type JobSettings,
  type JobStatus,
  type Preset,
} from './types';

type DB = Database.Database;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'pending',
  step TEXT NOT NULL DEFAULT '',
  progress REAL NOT NULL DEFAULT 0,
  input_path TEXT NOT NULL,
  video_name TEXT NOT NULL,
  settings_json TEXT NOT NULL,
  error TEXT,
  result_json TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status, created_at);

CREATE TABLE IF NOT EXISTS job_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  ts TEXT NOT NULL,
  level TEXT NOT NULL,
  message TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_logs_job ON job_logs(job_id, id);

CREATE TABLE IF NOT EXISTS clips (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL,
  title TEXT NOT NULL,
  start REAL NOT NULL,
  "end" REAL NOT NULL,
  score INTEGER NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  output_path TEXT,
  srt_path TEXT,
  metadata_path TEXT,
  error TEXT,
  UNIQUE(job_id, idx)
);

CREATE TABLE IF NOT EXISTS presets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  settings_json TEXT NOT NULL,
  builtin INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS favorites (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  clip_index INTEGER NOT NULL,
  video_name TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  hashtags_json TEXT,
  dir TEXT NOT NULL,
  video_path TEXT NOT NULL,
  srt_path TEXT,
  metadata_path TEXT NOT NULL,
  duration REAL NOT NULL DEFAULT 0,
  favorited_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_favorites_date ON favorites(favorited_at);

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

const BUILTIN_PRESETS: { name: string; settings: Partial<JobSettings> }[] = [
  {
    name: 'Podcast Vertical com Muita Edição',
    settings: { format: 'vertical_blur', intensity: 'high', targetDuration: 45, maxClips: 'auto', useMemes: false, useSfx: false },
  },
  {
    name: 'Corte Educacional Limpo',
    settings: { format: 'original', intensity: 'low', targetDuration: 120, maxClips: 5, useMemes: false, useSfx: false },
  },
  {
    name: 'Reels Médio (9:16 recortado)',
    settings: { format: 'vertical_crop', intensity: 'medium', targetDuration: 60, maxClips: 'auto' },
  },
  {
    name: 'Feed Quadrado',
    settings: { format: 'square', intensity: 'medium', targetDuration: 60, maxClips: 6 },
  },
];

const globalForDb = globalThis as unknown as { __clipperDb?: DB };

export function getDb(): DB {
  if (globalForDb.__clipperDb) return globalForDb.__clipperDb;
  ensureDataDirs();
  const db = new Database(dataPaths.db);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  migrate(db);
  seedPresets(db);
  globalForDb.__clipperDb = db;
  return db;
}

function now(): string {
  return new Date().toISOString();
}

/** Migrações aditivas para bancos criados por versões anteriores. */
function migrate(db: DB) {
  const clipCols = new Set((db.prepare('PRAGMA table_info(clips)').all() as { name: string }[]).map((c) => c.name));
  if (!clipCols.has('description')) db.exec('ALTER TABLE clips ADD COLUMN description TEXT');
  if (!clipCols.has('hashtags_json')) db.exec('ALTER TABLE clips ADD COLUMN hashtags_json TEXT');
}

function seedPresets(db: DB) {
  const insert = db.prepare(
    `INSERT INTO presets (id, name, settings_json, builtin, created_at) VALUES (?, ?, ?, 1, ?)
     ON CONFLICT(name) DO UPDATE SET settings_json = excluded.settings_json WHERE presets.builtin = 1`,
  );
  for (const p of BUILTIN_PRESETS) {
    insert.run(randomUUID(), p.name, JSON.stringify({ ...DEFAULT_JOB_SETTINGS, ...p.settings }), now());
  }
}

// ---------------- Jobs ----------------

interface JobRow {
  id: string;
  status: JobStatus;
  step: string;
  progress: number;
  input_path: string;
  video_name: string;
  settings_json: string;
  error: string | null;
  result_json: string | null;
  attempts: number;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
}

function toJob(r: JobRow): Job {
  return {
    id: r.id,
    status: r.status,
    step: r.step,
    progress: r.progress,
    inputPath: r.input_path,
    videoName: r.video_name,
    settings: { ...DEFAULT_JOB_SETTINGS, ...JSON.parse(r.settings_json) },
    error: r.error,
    result: r.result_json ? JSON.parse(r.result_json) : null,
    attempts: r.attempts,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
  };
}

export function createJob(inputPath: string, videoName: string, settings: JobSettings): Job {
  const id = randomUUID();
  const ts = now();
  getDb()
    .prepare(
      `INSERT INTO jobs (id, status, input_path, video_name, settings_json, created_at, updated_at)
       VALUES (?, 'pending', ?, ?, ?, ?, ?)`,
    )
    .run(id, inputPath, videoName, JSON.stringify(settings), ts, ts);
  return getJob(id)!;
}

export function getJob(id: string): Job | null {
  const r = getDb().prepare('SELECT * FROM jobs WHERE id = ?').get(id) as JobRow | undefined;
  return r ? toJob(r) : null;
}

/** Jobs do painel. Ajustes de corte ficam de fora: aparecem no próprio corte (listRevisions). */
export function listJobs(limit = 50): Job[] {
  const rows = getDb()
    .prepare(`SELECT * FROM jobs WHERE settings_json NOT LIKE '%"parentJobId"%' ORDER BY created_at DESC LIMIT ?`)
    .all(limit) as JobRow[];
  return rows.map(toJob);
}

/** Ajustes pedidos nos cortes de um job, do mais recente para o mais antigo. */
export function listRevisions(parentJobId: string, limit = 50): Job[] {
  const rows = getDb()
    .prepare(`SELECT * FROM jobs WHERE settings_json LIKE ? ORDER BY created_at DESC LIMIT ?`)
    .all(`%"parentJobId":${JSON.stringify(parentJobId)}%`, limit) as JobRow[];
  return rows.map(toJob).filter((j) => j.settings.revision?.parentJobId === parentJobId);
}

/** Pega atomicamente o próximo job pendente e o marca como 'processing'. */
export function claimNextJob(): Job | null {
  const db = getDb();
  const tx = db.transaction(() => {
    const r = db
      .prepare("SELECT id FROM jobs WHERE status = 'pending' ORDER BY created_at ASC LIMIT 1")
      .get() as { id: string } | undefined;
    if (!r) return null;
    const ts = now();
    db.prepare(
      `UPDATE jobs SET status = 'processing', attempts = attempts + 1, error = NULL,
         started_at = COALESCE(started_at, ?), updated_at = ? WHERE id = ? AND status = 'pending'`,
    ).run(ts, ts, r.id);
    return r.id;
  });
  const id = tx.immediate();
  return id ? getJob(id) : null;
}

/** Recuperação de falhas: jobs que estavam 'processing' quando o worker caiu voltam para a fila. */
export function requeueStaleJobs(): number {
  const res = getDb()
    .prepare("UPDATE jobs SET status = 'pending', updated_at = ? WHERE status = 'processing'")
    .run(now());
  return res.changes;
}

export function updateJobProgress(id: string, step: string, progress: number): void {
  getDb()
    .prepare('UPDATE jobs SET step = ?, progress = ?, updated_at = ? WHERE id = ?')
    .run(step, Math.max(0, Math.min(1, progress)), now(), id);
}

/** Troca o nome mostrado do job (ex.: o título do VOD, que só se sabe depois de consultar a Twitch). */
export function renameJob(id: string, videoName: string): void {
  getDb().prepare('UPDATE jobs SET video_name = ?, updated_at = ? WHERE id = ?').run(videoName.slice(0, 200), now(), id);
}

export function setJobResult(id: string, result: JobResult): void {
  getDb().prepare('UPDATE jobs SET result_json = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(result), now(), id);
}

export function finishJob(id: string, status: Extract<JobStatus, 'completed' | 'failed'>, error?: string): void {
  const ts = now();
  getDb()
    .prepare(
      `UPDATE jobs SET status = ?, error = ?, progress = CASE WHEN ? = 'completed' THEN 1 ELSE progress END,
         finished_at = ?, updated_at = ? WHERE id = ? AND status = 'processing'`,
    )
    .run(status, error ?? null, status, ts, ts, id);
}

export function cancelJob(id: string): boolean {
  const res = getDb()
    .prepare(
      "UPDATE jobs SET status = 'cancelled', finished_at = ?, updated_at = ? WHERE id = ? AND status IN ('pending','processing')",
    )
    .run(now(), now(), id);
  return res.changes > 0;
}

export function retryJob(id: string): boolean {
  const res = getDb()
    .prepare(
      "UPDATE jobs SET status = 'pending', error = NULL, finished_at = NULL, updated_at = ? WHERE id = ? AND status IN ('failed','cancelled','completed')",
    )
    .run(now(), id);
  return res.changes > 0;
}

export function deleteJob(id: string): boolean {
  return getDb().prepare("DELETE FROM jobs WHERE id = ? AND status != 'processing'").run(id).changes > 0;
}

export function getJobStatus(id: string): JobStatus | null {
  const r = getDb().prepare('SELECT status FROM jobs WHERE id = ?').get(id) as { status: JobStatus } | undefined;
  return r?.status ?? null;
}

// ---------------- Logs ----------------

export function addJobLog(jobId: string, level: JobLog['level'], message: string): void {
  getDb()
    .prepare('INSERT INTO job_logs (job_id, ts, level, message) VALUES (?, ?, ?, ?)')
    .run(jobId, now(), level, message.slice(0, 4000));
}

export function listJobLogs(jobId: string, afterId = 0, limit = 500): JobLog[] {
  const rows = getDb()
    .prepare('SELECT id, job_id, ts, level, message FROM job_logs WHERE job_id = ? AND id > ? ORDER BY id ASC LIMIT ?')
    .all(jobId, afterId, limit) as { id: number; job_id: string; ts: string; level: JobLog['level']; message: string }[];
  return rows.map((r) => ({ id: r.id, jobId: r.job_id, ts: r.ts, level: r.level, message: r.message }));
}

// ---------------- Clips ----------------

interface ClipRow {
  id: string;
  job_id: string;
  idx: number;
  title: string;
  start: number;
  end: number;
  score: number;
  reason: string;
  status: ClipStatus;
  output_path: string | null;
  srt_path: string | null;
  metadata_path: string | null;
  error: string | null;
  description: string | null;
  hashtags_json: string | null;
}

function toClip(r: ClipRow): Clip {
  return {
    id: r.id,
    jobId: r.job_id,
    index: r.idx,
    title: r.title,
    start: r.start,
    end: r.end,
    score: r.score,
    reason: r.reason,
    status: r.status,
    outputPath: r.output_path,
    srtPath: r.srt_path,
    metadataPath: r.metadata_path,
    error: r.error,
    description: r.description,
    hashtags: r.hashtags_json ? JSON.parse(r.hashtags_json) : [],
  };
}

export function replaceClips(
  jobId: string,
  clips: { index: number; title: string; start: number; end: number; score: number; reason: string }[],
): void {
  const db = getDb();
  db.transaction(() => {
    db.prepare('DELETE FROM clips WHERE job_id = ?').run(jobId);
    const ins = db.prepare(
      'INSERT INTO clips (id, job_id, idx, title, start, "end", score, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    );
    for (const c of clips) ins.run(randomUUID(), jobId, c.index, c.title, c.start, c.end, Math.round(c.score), c.reason);
  })();
}

export function updateClip(
  jobId: string,
  index: number,
  patch: Partial<Pick<Clip, 'status' | 'outputPath' | 'srtPath' | 'metadataPath' | 'error' | 'title' | 'description' | 'hashtags'>>,
): void {
  const cols: string[] = [];
  const vals: unknown[] = [];
  const map: Record<string, string> = {
    status: 'status',
    outputPath: 'output_path',
    srtPath: 'srt_path',
    metadataPath: 'metadata_path',
    error: 'error',
    title: 'title',
    description: 'description',
    hashtags: 'hashtags_json',
  };
  for (const [k, v] of Object.entries(patch)) {
    cols.push(`${map[k]} = ?`);
    vals.push(k === 'hashtags' ? JSON.stringify(v ?? []) : (v ?? null));
  }
  if (!cols.length) return;
  getDb()
    .prepare(`UPDATE clips SET ${cols.join(', ')} WHERE job_id = ? AND idx = ?`)
    .run(...vals, jobId, index);
}

export function listClips(jobId: string): Clip[] {
  const rows = getDb().prepare('SELECT * FROM clips WHERE job_id = ? ORDER BY idx ASC').all(jobId) as ClipRow[];
  return rows.map(toClip);
}

// ---------------- Favoritos ----------------

interface FavoriteRow {
  id: string;
  job_id: string;
  clip_index: number;
  video_name: string;
  title: string;
  description: string | null;
  hashtags_json: string | null;
  dir: string;
  video_path: string;
  srt_path: string | null;
  metadata_path: string;
  duration: number;
  favorited_at: string;
  updated_at: string;
}

function toFavorite(r: FavoriteRow): Favorite {
  return {
    id: r.id,
    jobId: r.job_id,
    clipIndex: r.clip_index,
    videoName: r.video_name,
    title: r.title,
    description: r.description,
    hashtags: r.hashtags_json ? JSON.parse(r.hashtags_json) : [],
    dir: r.dir,
    videoPath: r.video_path,
    srtPath: r.srt_path,
    metadataPath: r.metadata_path,
    duration: r.duration,
    favoritedAt: r.favorited_at,
    updatedAt: r.updated_at,
  };
}

export function insertFavorite(f: Omit<Favorite, 'favoritedAt' | 'updatedAt'>): Favorite {
  const ts = now();
  getDb()
    .prepare(
      `INSERT INTO favorites (id, job_id, clip_index, video_name, title, description, hashtags_json, dir, video_path, srt_path, metadata_path, duration, favorited_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(f.id, f.jobId, f.clipIndex, f.videoName, f.title, f.description, JSON.stringify(f.hashtags), f.dir, f.videoPath, f.srtPath, f.metadataPath, f.duration, ts, ts);
  return getFavorite(f.id)!;
}

export function getFavorite(id: string): Favorite | null {
  const r = getDb().prepare('SELECT * FROM favorites WHERE id = ?').get(id) as FavoriteRow | undefined;
  return r ? toFavorite(r) : null;
}

/** Favoritos, do mais recente para o mais antigo; `from`/`to` filtram pelo dia em que foram favoritados (AAAA-MM-DD). */
export function listFavorites(filter: { from?: string; to?: string } = {}): Favorite[] {
  const where: string[] = [];
  const vals: string[] = [];
  if (filter.from) where.push('favorited_at >= ?'), vals.push(new Date(`${filter.from}T00:00:00`).toISOString());
  if (filter.to) where.push('favorited_at < ?'), vals.push(new Date(new Date(`${filter.to}T00:00:00`).getTime() + 86_400_000).toISOString());
  const rows = getDb()
    .prepare(`SELECT * FROM favorites ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY favorited_at DESC`)
    .all(...vals) as FavoriteRow[];
  return rows.map(toFavorite);
}

export function updateFavorite(id: string, patch: Partial<Pick<Favorite, 'title' | 'description' | 'hashtags' | 'videoPath' | 'srtPath' | 'metadataPath' | 'duration'>>): void {
  const cur = getFavorite(id);
  if (!cur) return;
  const f = { ...cur, ...patch };
  getDb()
    .prepare('UPDATE favorites SET title = ?, description = ?, hashtags_json = ?, video_path = ?, srt_path = ?, metadata_path = ?, duration = ?, updated_at = ? WHERE id = ?')
    .run(f.title, f.description, JSON.stringify(f.hashtags), f.videoPath, f.srtPath, f.metadataPath, f.duration, now(), id);
}

export function deleteFavorite(id: string): boolean {
  return getDb().prepare('DELETE FROM favorites WHERE id = ?').run(id).changes > 0;
}

/** Ajustes pedidos em favoritos (mais recente primeiro). */
export function listFavoriteRevisions(limit = 200): Job[] {
  const rows = getDb().prepare(`SELECT * FROM jobs WHERE settings_json LIKE '%"favoriteId"%' ORDER BY created_at DESC LIMIT ?`).all(limit) as JobRow[];
  return rows.map(toJob);
}

// ---------------- Presets ----------------

export function listPresets(): Preset[] {
  const rows = getDb().prepare('SELECT * FROM presets ORDER BY builtin DESC, name ASC').all() as {
    id: string;
    name: string;
    settings_json: string;
    builtin: number;
    created_at: string;
  }[];
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    settings: { ...DEFAULT_JOB_SETTINGS, ...JSON.parse(r.settings_json) },
    builtin: !!r.builtin,
    createdAt: r.created_at,
  }));
}

export function savePreset(name: string, settings: JobSettings): Preset {
  const db = getDb();
  db.prepare(
    `INSERT INTO presets (id, name, settings_json, builtin, created_at) VALUES (?, ?, ?, 0, ?)
     ON CONFLICT(name) DO UPDATE SET settings_json = excluded.settings_json WHERE presets.builtin = 0`,
  ).run(randomUUID(), name, JSON.stringify(settings), now());
  return listPresets().find((p) => p.name === name)!;
}

export function deletePreset(id: string): boolean {
  return getDb().prepare('DELETE FROM presets WHERE id = ? AND builtin = 0').run(id).changes > 0;
}

// ---------------- App settings ----------------

export function getAppSettings(): AppSettings {
  const rows = getDb().prepare('SELECT key, value FROM app_settings').all() as { key: string; value: string }[];
  const stored: Record<string, unknown> = {};
  for (const r of rows) {
    try {
      stored[r.key] = JSON.parse(r.value);
    } catch {
      /* ignora valor corrompido */
    }
  }
  return { ...DEFAULT_APP_SETTINGS, ...stored } as AppSettings;
}

export function saveAppSettings(patch: Partial<AppSettings>): AppSettings {
  const db = getDb();
  const up = db.prepare(
    'INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  );
  db.transaction(() => {
    for (const [k, v] of Object.entries(patch)) {
      if (k in DEFAULT_APP_SETTINGS && v !== undefined) up.run(k, JSON.stringify(v));
    }
  })();
  return getAppSettings();
}
