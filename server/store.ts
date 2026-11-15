// Tiny JSON-file persistence: game history, the bot's learned lessons, spend log, Reppo queue.
import fs from 'node:fs';
import path from 'node:path';
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

const DIR = path.resolve(process.cwd(), process.env.DATA_DIR ?? 'data');
const FILE = path.join(DIR, 'store.json');

function empty(): Data {
  return { players: {}, games: [], lessons: [], spend: [] };
}

function load(): Data {
  try {
    return { ...empty(), ...JSON.parse(fs.readFileSync(FILE, 'utf8')) };
  } catch {
    return empty();
  }
}

export const db: Data = load();

export function persist() {
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

const MAX_LESSONS = 10;

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
