import express from 'express';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { Server, type Socket } from 'socket.io';
import type { Result, Session, Stats } from '../shared/types';
import { config, reppoEnabled, servEnabled } from './config';
import { Room } from './game';
import { isAddress } from './kite';
import { brainLabel } from './serv';
import { db, flushStore, gamesLast24h, initStore, storeKind } from './store';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: true }, maxHttpBufferSize: 20_000 });

const rooms = new Map<string, Room>();
const bindings = new Map<string, { code: string; playerId: string }>();

// ---------- HTTP ----------

app.get('/api/health', (_req, res) => res.json({ ok: true, rooms: rooms.size }));

app.get('/api/stats', (_req, res) => {
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  const games = db.games.map((g) => ({
    id: g.id,
    endedAt: g.endedAt,
    winner: g.winner,
    botName: g.botName,
    humans: g.humans,
    rounds: g.rounds,
    bribesOffered: g.bribes.length,
    bribesAccepted: g.bribes.filter((b) => b.status === 'accepted').length,
    bribeSpend: g.bribes.filter((b) => b.status === 'accepted').reduce((a, b) => a + b.amount, 0),
    avgRating: avg(g.ratings),
    reppoScore: g.reppo?.score ?? null,
    reppoStatus: g.reppo?.status ?? null,
  }));
  const stats: Stats = {
    leaderboard: Object.values(db.players)
      .sort((a, b) => b.caught - a.caught || b.earned - a.earned)
      .slice(0, 12),
    games,
    survivalRate: games.length ? games.filter((g) => g.winner === 'bot').length / games.length : null,
    avgRating: avg(games.flatMap((g) => (g.avgRating === null ? [] : [g.avgRating]))),
    avgReppo: avg(games.flatMap((g) => (g.reppoScore === null ? [] : [g.reppoScore]))),
    totalSpent: db.spend.reduce((a, s) => a + s.amount, 0),
    unit: config.kite.unit,
    lessons: db.lessons.map(({ text, source, ts }) => ({ text, source, ts })),
    integrations: {
      serv: brainLabel,
      kite: config.kite.mode === 'mock' ? 'mock ledger (set KITE_MODE=kpass or chain)' : config.kite.mode === 'chain' ? `Kite testnet, paid in ${config.kite.native ? 'KITE' : 'pieUSD'}` : 'Kite Passport (kpass)',
      reppo: reppoEnabled ? 'Reppo Evaluation API' : 'disabled (no REPPO_API_KEY)',
    },
  };
  res.json(stats);
});

const dist = path.resolve(process.cwd(), 'dist/client');
if (fs.existsSync(dist)) {
  app.use(express.static(dist, { maxAge: '1h', index: false }));
  app.use((_req, res) => res.sendFile(path.join(dist, 'index.html')));
}

// ---------- abuse limits ----------
// Every game spends SERV and Reppo credits and (in chain mode) real testnet funds, so a public
// deployment needs ceilings on how fast strangers can create work.

const createdByIp = new Map<string, number[]>();

function ipOf(socket: Socket): string {
  const fwd = socket.handshake.headers['x-forwarded-for'];
  return (Array.isArray(fwd) ? fwd[0] : fwd)?.split(',')[0].trim() || socket.handshake.address || 'unknown';
}

function mayCreateRoom(ip: string): string | null {
  if (rooms.size >= config.limits.maxRooms) return 'The server is full right now. Try again in a few minutes.';
  const hourAgo = Date.now() - 3600_000;
  const recent = (createdByIp.get(ip) ?? []).filter((t) => t > hourAgo);
  if (recent.length >= config.limits.roomsPerIpPerHour) return 'You have created a lot of rooms. Try again later.';
  createdByIp.set(ip, [...recent, Date.now()]);
  return null;
}

// ---------- sockets ----------

const cleanName = (v: unknown) =>
  String(v ?? '')
    .replace(/[^\p{L}\p{N} _.\-]/gu, '')
    .trim()
    .slice(0, 20);

function cleanWallet(v: unknown): string | undefined | false {
  const s = String(v ?? '').trim();
  if (!s) return undefined;
  return isAddress(s) ? s : false;
}

function newCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let code = '';
  do code = Array.from({ length: 4 }, () => A[Math.floor(Math.random() * A.length)]).join('');
  while (rooms.has(code));
  return code;
}

type Ack = (r: Result<{ session?: Session }>) => void;
const ackOf = (cb: unknown): Ack => (typeof cb === 'function' ? (cb as Ack) : () => {});

io.on('connection', (socket: Socket) => {
  const ctx = () => {
    const b = bindings.get(socket.id);
    const room = b && rooms.get(b.code);
    const player = room?.byId(b!.playerId);
    return room && player ? { room, player } : null;
  };

  const bind = (room: Room, playerId: string) => {
    const p = room.byId(playerId)!;
    p.socketId = socket.id;
    bindings.set(socket.id, { code: room.code, playerId });
    room.broadcast();
  };

  const enter = (room: Room, d: { name?: unknown; wallet?: unknown }, isHost: boolean, ack: Ack): boolean => {
    const name = cleanName(d?.name);
    if (!name) return ack({ ok: false, error: 'Enter a name' }), false;
    const wallet = cleanWallet(d?.wallet);
    if (wallet === false) return ack({ ok: false, error: 'Wallet must be a 0x… address (or leave it empty)' }), false;
    const p = room.addHuman(name, wallet, isHost);
    if (typeof p === 'string') return ack({ ok: false, error: p }), false;
    bind(room, p.id);
    ack({ ok: true, session: { code: room.code, playerId: p.id, token: p.token } });
    return true;
  };

  socket.on('create', (d, cb) => {
    const blocked = mayCreateRoom(ipOf(socket));
    if (blocked) return ackOf(cb)({ ok: false, error: blocked });
    const code = newCode();
    const room = new Room(code, io);
    rooms.set(code, room);
    if (!enter(room, d, true, ackOf(cb))) rooms.delete(code);
  });

  socket.on('join', (d, cb) => {
    const room = rooms.get(String(d?.code ?? '').toUpperCase().trim());
    if (!room) return ackOf(cb)({ ok: false, error: 'Room not found' });
    enter(room, d, false, ackOf(cb));
  });

  socket.on('resume', (d: Partial<Session>, cb) => {
    const room = rooms.get(String(d?.code ?? ''));
    const p = room?.byId(String(d?.playerId ?? ''));
    if (!room || !p || p.isBot || p.token !== d?.token) return ackOf(cb)({ ok: false, error: 'Session expired' });
    bind(room, p.id);
    ackOf(cb)({ ok: true });
  });

  socket.on('leave', (_d, cb) => {
    const c = ctx();
    bindings.delete(socket.id);
    if (c) {
      c.player.socketId = undefined;
      // Leaving a lobby frees the seat (and hands the host role on); an empty lobby is closed.
      if (c.room.leaveLobby(c.player.id)) {
        c.room.dispose();
        rooms.delete(c.room.code);
      }
    }
    ackOf(cb)({ ok: true });
  });

  const withCtx = (fn: (c: NonNullable<ReturnType<typeof ctx>>, d: any) => Result | Promise<Result>) => async (d: unknown, cb: unknown) => {
    const c = ctx();
    if (!c) return ackOf(cb)({ ok: false, error: 'Not in a room' });
    try {
      ackOf(cb)(await fn(c, d ?? {}));
    } catch (e) {
      console.error('[socket] handler failed:', e);
      ackOf(cb)({ ok: false, error: 'Something went wrong' });
    }
  };

  socket.on(
    'start',
    withCtx(({ room, player }) => {
      if (gamesLast24h() >= config.limits.gamesPerDay) return { ok: false, error: "Bribot has reached today's game limit. Come back tomorrow." };
      return room.start(player.id);
    }),
  );
  socket.on('chat', withCtx(({ room, player }, d) => room.chat(player.id, d.text)));
  socket.on('whisper', withCtx(({ room, player }, d) => room.whisper(player.id, String(d.toId), d.text)));
  socket.on('vote', withCtx(({ room, player }, d) => room.castVote(player.id, String(d.targetId))));
  socket.on('rate', withCtx(({ room, player }, d) => room.rate(player.id, d.score, d.comment)));
  socket.on(
    'bribe:respond',
    withCtx(({ room, player }, d) => {
      const action = d.action;
      if (!['accept', 'decline', 'expose'].includes(action)) return { ok: false, error: 'Bad action' };
      return room.respondBribe(player.id, String(d.whisperId), action);
    }),
  );

  socket.on('disconnect', () => {
    const c = ctx();
    bindings.delete(socket.id);
    if (c && c.player.socketId === socket.id) c.player.socketId = undefined;
  });
});

// Housekeeping: close rooms nobody is using, forget old rate-limit entries.
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    const idle = now - room.lastActivity;
    const abandoned = !room.hasConnectedHumans() && idle > 10 * 60_000;
    const stale = idle > (room.phase === 'lobby' ? 30 * 60_000 : 2 * 3600_000);
    if (abandoned || stale) {
      room.dispose();
      rooms.delete(code);
    }
  }
  for (const [ip, ts] of createdByIp) if (ts.every((t) => t < now - 3600_000)) createdByIp.delete(ip);
}, 60_000).unref();

// Keep-alive: hosts that put idle services to sleep count outside traffic, so the server
// requests its own public address every few minutes while it is running.
if (config.publicUrl) {
  setInterval(() => void fetch(`${config.publicUrl}/api/health`).catch(() => {}), 4 * 60_000).unref();
}

process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e));
process.on('uncaughtException', (e) => console.error('[uncaughtException]', e));

// Clean shutdown (redeploys send SIGTERM): stop taking players, save, exit.
let closing = false;
async function shutdown(signal: string) {
  if (closing) return;
  closing = true;
  console.log(`${signal} received, saving and shutting down…`);
  io.close();
  for (const room of rooms.values()) room.dispose();
  await flushStore();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await initStore();
server.listen(config.port, () => {
  console.log(`Bribot server on http://localhost:${config.port}`);
  console.log(`  brain:   ${brainLabel}${servEnabled ? '' : '  <- set SERV_API_KEY in .env'}`);
  console.log(`  kite:    ${config.kite.mode}`);
  console.log(`  reppo:   ${reppoEnabled ? 'enabled' : 'disabled'}`);
  console.log(`  storage: ${storeKind}`);
  if (config.publicUrl) console.log(`  public:  ${config.publicUrl} (keep-alive on)`);
});
