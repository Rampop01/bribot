// End-to-end smoke test: 2 scripted humans play a full game against the bot over real sockets.
// Start the server with short timers first, e.g.:
//   CHAT_SECONDS=20 VOTE_SECONDS=8 npx tsx server/index.ts
import { createHash } from 'node:crypto';
import { io, type Socket } from 'socket.io-client';
import type { RoomView } from '../shared/types';

const URL = process.env.URL ?? 'http://localhost:3001';
const call = (s: Socket, ev: string, d: unknown = {}) => new Promise<any>((r) => s.emit(ev, d, r));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const a = io(URL);
const b = io(URL);
const views: Record<string, RoomView> = {};
a.on('state', (v) => (views.a = v));
b.on('state', (v) => (views.b = v));

const created = await call(a, 'create', { name: 'Ada', wallet: process.env.WALLET });
console.log('create', created.ok, created.session?.code);
const joined = await call(b, 'join', { name: 'Bayo', wallet: process.env.WALLET, code: created.session.code });
console.log('join', joined.ok);

while ((views.a?.players.length ?? 0) < 2) await sleep(300); // the bot only appears once the game starts
console.log('lobby players:', views.a.players.map((p) => p.name).join(', '));
console.log('start', (await call(a, 'start')).ok);

const lines = ['i had jollof rice lol', 'cereal again, im boring', 'wait who is the quiet one', 'ok thats sus', 'nah im human i promise'];
let bribeHandled = false;
while (views.a.phase !== 'reveal') {
  const v = views.a;
  if (v.phase === 'chat') {
    await call(Math.random() < 0.5 ? a : b, 'chat', { text: lines[Math.floor(Math.random() * lines.length)] });
    for (const [s, key] of [
      [a, 'a'],
      [b, 'b'],
    ] as const) {
      const bribe = views[key]?.whispers.find((w) => w.status === 'pending' && w.amount);
      if (bribe && !bribeHandled) {
        bribeHandled = true;
        console.log(`bribe to ${key}: "${bribe.text}" $${bribe.amount}`);
        console.log('accept', (await call(s, 'bribe:respond', { whisperId: bribe.id, action: 'accept' })).ok);
      }
    }
    await sleep(3000);
  } else if (v.phase === 'vote') {
    for (const [s, key] of [
      [a, 'a'],
      [b, 'b'],
    ] as const) {
      const me = views[key];
      if (me.me.alive && !me.myVote) {
        const target = me.players.find((p) => p.alive && p.id !== me.me.id); // codenames hide who the bot is
        if (target) await call(s, 'vote', { targetId: target.id });
      }
    }
    await sleep(1000);
  } else await sleep(500);
}

await sleep(1500);
const r = views.a.reveal!;
console.log('\nRESULT:', r.winner, '| bot was', r.botName, '| brain:', r.brain);
console.log('messages:', views.a.messages.length, '| reasoning steps:', r.reasoning.length);
console.log('bot lines:', views.a.messages.filter((m) => m.name === r.botName).map((m) => m.text));
console.log('bribes:', JSON.stringify(r.bribes.map((x) => ({ to: x.toName, amt: x.amount, st: x.status, tx: x.txUrl, err: x.error }))));
console.log('payouts:', JSON.stringify(r.payouts));
console.log('commitment verifies:', createHash('sha256').update(r.commitInput).digest('hex') === r.commitment);
console.log('rate', (await call(a, 'rate', { score: 2, comment: 'too fast' })).ok, (await call(b, 'rate', { score: 3, comment: '' })).ok);
console.log('reasoning log:');
for (const e of r.reasoning) console.log(`  [R${e.round} ${e.kind}] ${e.reasoning}${e.detail ? `  => ${e.detail}` : ''}`);
for (let i = 0; i < 40 && views.a.reveal!.reppo.status === 'pending'; i++) await sleep(4000);
console.log('reppo:', JSON.stringify(views.a.reveal!.reppo));
await sleep(8000); // let post-game reflection finish
const stats = await (await fetch(`${URL}/api/stats`)).json();
console.log('stats games:', stats.games.length, 'survival:', stats.survivalRate, 'spent:', stats.totalSpent);
console.log('lessons:', JSON.stringify(stats.lessons.map((l: { source: string; text: string }) => `${l.source}: ${l.text}`), null, 1));
a.close();
b.close();
process.exit(0);
