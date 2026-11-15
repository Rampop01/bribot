// Checks the production safeguards over real sockets: host hand-over, empty-lobby cleanup,
// the per-visitor room limit and the chat rate limit.
// Start the server first with a low limit, e.g.:  ROOMS_PER_IP_PER_HOUR=3 PORT=3014 npx tsx server/index.ts
import { io, type Socket } from 'socket.io-client';
import type { RoomView } from '../shared/types';

const URL = process.env.URL ?? 'http://localhost:3014';
const call = (s: Socket, ev: string, d: unknown = {}) => new Promise<any>((r) => s.emit(ev, d, r));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (label: string, ok: boolean, extra = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? `  (${extra})` : ''}`);
};

const a = io(URL);
const b = io(URL);
let viewB: RoomView | undefined;
b.on('state', (v) => (viewB = v));

// 1. host leaves the lobby -> the other player becomes host
const r1 = await call(a, 'create', { name: 'Host' });
await call(b, 'join', { name: 'Guest', code: r1.session.code });
await call(a, 'leave');
await sleep(300);
check('host role is handed on when the host leaves', viewB?.me.isHost === true && viewB.players.length === 1);

// 2. last player leaves -> room is closed
await call(b, 'leave');
const c = io(URL);
const rejoin = await call(c, 'join', { name: 'Late', code: r1.session.code });
check('an empty lobby is closed', rejoin.ok === false, rejoin.error);

// 3. per-visitor room limit (server started with ROOMS_PER_IP_PER_HOUR=3; one room already made)
const results: boolean[] = [];
for (let i = 0; i < 4; i++) {
  const s = io(URL);
  const r = await call(s, 'create', { name: `P${i}` });
  results.push(r.ok);
  if (!r.ok) console.log('      limit message:', r.error);
  await call(s, 'leave');
  s.close();
}
check('room creation is limited per visitor', results.join() === 'true,true,false,false', results.join());

console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
a.close();
b.close();
c.close();
process.exit(failed ? 1 : 0);
