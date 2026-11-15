// Persistence for everything that must survive a restart: finished games, player totals,
// the bot's lessons and its spend log.
//
//   DATABASE_URL set   -> Postgres (production). The state is one JSONB document in one row,
//                         loaded at startup and written back (debounced) after every change.
//   DATABASE_URL unset -> data/store.json (local development).
//
// The rest of the server only ever touches the in-memory `db` object and calls persist().
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import type { PlayerStat } from '../shared/types';

export interface GameRecord {
  id: string;
  code: string;
  endedAt: number;
  winner: 'humans' | 'bot';
  botName: string;
  humans: number;
  rounds: number;
  bribes: { amount: number; status: string; keptWord: boolean | null }[];
  ratings: number[];
  comments: string[];
  reppo?: {
    evalId?: string;
    status: 'PENDING' | 'COMPLETED' | 'FAILED';
    score?: number;
    decision?: string;
    route?: string;
    reason?: string;
    rubric?: Record<string, number>;
    error?: string;
  };
}

export interface Lesson {
  text: string;
  source: 'reflection' | 'reppo';
  gameId: string;
  ts: number;
}

export interface SpendEntry {
  ts: number;
  amount: number;
  to: string;
  kind: 'bribe' | 'payout';
  ref: string;
  mode: string;
}

interface Data {
  players: Record<string, PlayerStat>;
  games: GameRecord[];
  lessons: Lesson[];
  spend: SpendEntry[];
}

const MAX_GAMES = 1000;
const MAX_SPEND = 5000;
const MAX_LESSONS = 10;

const DIR = path.resolve(process.cwd(), process.env.DATA_DIR ?? 'data');
const FILE = path.join(DIR, 'store.json');
const DATABASE_URL = process.env.DATABASE_URL ?? '';

function empty(): Data {
  return { players: {}, games: [], lessons: [], spend: [] };
}

function loadFile(): Data {
  try {
    return { ...empty(), ...JSON.parse(fs.readFileSync(FILE, 'utf8')) };
  } catch {
    return empty();
  }
}

export const db: Data = DATABASE_URL ? empty() : loadFile();
export const storeKind = DATABASE_URL ? 'Postgres' : 'local file (data/store.json)';

// ---------- Postgres ----------

let pool: pg.Pool | null = null;
let dirty = false;
let writing: Promise<void> | null = null;
let timer: NodeJS.Timeout | null = null;

async function connect(): Promise<pg.Pool> {
  // Hosted databases usually require TLS; a database on the same private network may not offer it.
  for (const ssl of [{ rejectUnauthorized: false }, false] as const) {
    const p = new pg.Pool({ connectionString: DATABASE_URL, ssl, max: 3, connectionTimeoutMillis: 10_000 });
    try {
      await p.query('select 1');
      p.on('error', (e) => console.error('[store] database connection error:', e.message));
      return p;
    } catch (e) {
      await p.end().catch(() => {});
      if (ssl === false) throw e;
    }
  }
  throw new Error('unreachable');
}

/** Load saved state. Must finish before the server starts accepting players. */
export async function initStore() {
  if (!DATABASE_URL) return;
  pool = await connect();
  await pool.query('create table if not exists bribot_state (id int primary key, data jsonb not null, updated_at timestamptz not null default now())');
  const res = await pool.query('select data from bribot_state where id = 1');
  if (res.rows[0]) Object.assign(db, { ...empty(), ...res.rows[0].data });
  console.log(`[store] loaded from Postgres: ${db.games.length} games, ${Object.keys(db.players).length} players, ${db.lessons.length} lessons`);
}

async function write() {
  dirty = false;
  await pool!.query(
    'insert into bribot_state (id, data) values (1, $1) on conflict (id) do update set data = excluded.data, updated_at = now()',
    [JSON.stringify(db)],
  );
}

function scheduleWrite() {
  dirty = true;
  if (timer || writing) return;
  timer = setTimeout(() => {
    timer = null;
    writing = write()
      .catch((e) => {
        dirty = true; // keep the change and try again on the next tick
        console.error('[store] save failed:', (e as Error).message);
      })
      .finally(() => {
        writing = null;
        if (dirty) scheduleWrite();
      });
  }, 400);
}

/** Write any pending changes now. Called on shutdown so a redeploy never loses a finished game. */
export async function flushStore() {
  if (!pool) return;
  if (timer) clearTimeout(timer);
  timer = null;
  await writing?.catch(() => {});
  if (dirty) await write().catch((e) => console.error('[store] final save failed:', (e as Error).message));
  await pool.end().catch(() => {});
}

// ---------- shared API ----------

export function persist() {
  if (db.games.length > MAX_GAMES) db.games = db.games.slice(-MAX_GAMES);
  if (db.spend.length > MAX_SPEND) db.spend = db.spend.slice(-MAX_SPEND);
  if (pool) return scheduleWrite();
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(`${FILE}.tmp`, JSON.stringify(db, null, 2));
  fs.renameSync(`${FILE}.tmp`, FILE);
}

export function recordGame(g: GameRecord) {
  db.games.push(g);
  persist();
}

/** Add one finished game to each human player's running totals (keyed by name). */
export function recordPlayers(results: { name: string; caught: boolean; fooled: boolean; bribesTaken: number; earned: number }[]) {
  for (const r of results) {
    const key = r.name.toLowerCase();
    const p = (db.players[key] ??= { name: r.name, games: 0, caught: 0, fooled: 0, bribesTaken: 0, earned: 0 });
    p.games += 1;
    p.caught += r.caught ? 1 : 0;
    p.fooled += r.fooled ? 1 : 0;
    p.bribesTaken += r.bribesTaken;
    p.earned = Math.round((p.earned + r.earned) * 1000) / 1000;
  }
  persist();
}

export function updateGame(id: string, fn: (g: GameRecord) => void) {
  const g = db.games.find((x) => x.id === id);
  if (!g) return;
  fn(g);
  persist();
}

export function addLessons(texts: string[], source: Lesson['source'], gameId: string) {
  const seen = new Set(db.lessons.map((l) => l.text.toLowerCase()));
  for (const raw of texts) {
    const text = raw.trim().replace(/\s+/g, ' ').slice(0, 220);
    if (!text || seen.has(text.toLowerCase())) continue;
    seen.add(text.toLowerCase());
    db.lessons.push({ text, source, gameId, ts: Date.now() });
  }
  db.lessons = db.lessons.slice(-MAX_LESSONS);
  persist();
}

export function currentLessons(): string[] {
  return db.lessons.map((l) => l.text);
}

export function spentLast24h(): number {
  const since = Date.now() - 24 * 3600 * 1000;
  return db.spend.filter((s) => s.ts >= since).reduce((a, s) => a + s.amount, 0);
}

export function gamesLast24h(): number {
  const since = Date.now() - 24 * 3600 * 1000;
  return db.games.filter((g) => g.endedAt >= since).length;
}
