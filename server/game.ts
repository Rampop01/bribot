// Room state machine: lobby -> (chat -> vote) x N -> reveal.
import crypto from 'node:crypto';
import type { Server } from 'socket.io';
import type {
  BribeRecord,
  ChatMsg,
  Phase,
  RevealData,
  Result,
  RoomView,
  RoundResult,
  WhisperStatus,
  WhisperView,
} from '../shared/types';
import { BotAgent, NAMES } from './bot';
import { config, money } from './config';
import { pay, type PayResult } from './kite';
import { finalizeGame, reppoInput } from './learning';
import { evaluateGame } from './reppo';
import { brainLabel } from './serv';
import { recordGame, recordPlayers } from './store';

const TOPICS = [
  'What did you eat today, honestly?',
  'Worst job or chore you ever had?',
  'Which app do you waste the most time on?',
  'Describe your morning in 3 words, then defend it.',
  'Most overrated thing everyone loves?',
  'What would you do with a free Saturday?',
  'Last thing that made you laugh out loud?',
  'Pineapple on pizza: defend your answer.',
  'What is the most useless thing you own?',
  'Weirdest thing you believed as a kid?',
];

const newId = () => crypto.randomBytes(6).toString('hex');
const rand = (a: number, b: number) => a + Math.random() * (b - a);
const round2 = (n: number) => Math.round(n * 100) / 100;

export interface Player {
  id: string;
  token: string;
  name: string; // real name in the lobby; secret codename once the game starts
  realName: string | null; // null for the bot
  wallet?: string;
  isBot: boolean;
  isHost: boolean;
  alive: boolean;
  socketId?: string;
}

interface WhisperRec {
  id: string;
  fromId: string;
  toId: string;
  text: string;
  ts: number;
  round: number;
  status: WhisperStatus;
  amount?: number;
  voteForId?: string;
  pay?: PayResult;
}

export class Room {
  readonly gameId = newId();
  players: Player[] = [];
  phase: Phase = 'lobby';
  round = 0;
  readonly maxRounds = config.game.maxRounds;
  topic = '';
  phaseEndsAt = 0;
  phaseDuration = 0;
  messages: ChatMsg[] = [];
  votes = new Map<string, string>(); // voterId -> targetId
  history: RoundResult[] = [];
  lastActivity = Date.now();
  lastHumanMessageAt = 0;

  private whispers: WhisperRec[] = [];
  private bot: BotAgent | null = null;
  private commit: { salt: string; input: string; commitment: string } | null = null;
  private reveal: RevealData | null = null;
  private ratings = new Map<string, { score: number; comment: string }>();
  private usedTopics = new Set<string>();
  private lastWhisperAt = new Map<string, number>();
  private lastChatAt = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;
  private botJoinTimer: NodeJS.Timeout | null = null;
  private finalizeTimer: NodeJS.Timeout | null = null;
  private finalized = false;

  constructor(
    readonly code: string,
    private io: Server,
  ) {}

  // ---------- helpers ----------

  byId(id: string) {
    return this.players.find((p) => p.id === id);
  }

  byName(name: string) {
    const n = name.trim().replace(/^@/, '').toLowerCase();
    return n ? this.players.find((p) => p.name.toLowerCase() === n) : undefined;
  }

  private get humans() {
    return this.players.filter((p) => !p.isBot);
  }

  private get alive() {
    return this.players.filter((p) => p.alive);
  }

  private touch() {
    this.lastActivity = Date.now();
  }

  private system(text: string) {
    this.messages.push({ id: newId(), playerId: null, name: 'game', text, ts: Date.now(), round: this.round, kind: 'system' });
  }

  private setTimer(fn: () => void, seconds: number) {
    if (this.timer) clearTimeout(this.timer);
    this.phaseDuration = seconds;
    this.phaseEndsAt = Date.now() + seconds * 1000;
    this.timer = setTimeout(fn, seconds * 1000);
  }

  broadcast() {
    for (const p of this.humans) if (p.socketId) this.io.to(p.socketId).emit('state', this.viewFor(p));
  }

  // ---------- lobby ----------

  addHuman(name: string, wallet: string | undefined, isHost: boolean): Player | string {
    if (this.phase !== 'lobby') return 'That game has already started';
    if (this.players.length >= 8) return 'Room is full';
    if (this.byName(name)) return 'That name is taken in this room';
    const p: Player = { id: newId(), token: crypto.randomBytes(16).toString('hex'), name, realName: name, wallet, isBot: false, isHost, alive: true };
    this.players.push(p);
    this.touch();
    return p;
  }

  /**
   * Game start: the bot slips in (it is never visible in the lobby), every player gets a secret
   * codename from the same pool, and the seating order is shuffled. Nobody, not even the host,
   * can tell who is who from names or join order.
   */
  private seatEveryone() {
    const pool = [...NAMES].sort(() => Math.random() - 0.5).map((n) => n[0].toUpperCase() + n.slice(1));
    this.bot = new BotAgent(this, pool.pop()!);
    this.players.push({ id: this.bot.id, token: '', name: this.bot.name, realName: null, isBot: true, isHost: false, alive: true });
    for (const p of this.humans) p.name = pool.pop()!;
    this.players.sort(() => Math.random() - 0.5);
  }

  hasConnectedHumans() {
    return this.humans.some((p) => p.socketId);
  }

  /** A player leaves before the game starts. Returns true when the lobby is now empty. */
  leaveLobby(playerId: string): boolean {
    if (this.phase !== 'lobby') return false;
    const p = this.byId(playerId);
    if (!p) return this.players.length === 0;
    this.players = this.players.filter((x) => x.id !== playerId);
    if (p.isHost && this.players[0]) this.players[0].isHost = true; // hand the host role on
    this.broadcast();
    return this.players.length === 0;
  }

  start(playerId: string): Result {
    const p = this.byId(playerId);
    if (!p?.isHost) return { ok: false, error: 'Only the host can start' };
    if (this.phase !== 'lobby') return { ok: false, error: 'Already started' };
    if (this.humans.length < config.game.minPlayers - 1) return { ok: false, error: `Need at least ${config.game.minPlayers - 1} players` };
    this.seatEveryone();
    // Provably fair: publish a hash of the bot's identity now, reveal the preimage at the end.
    const salt = crypto.randomBytes(16).toString('hex');
    const input = `${this.code}:${this.bot!.id}:${salt}`;
    this.commit = { salt, input, commitment: crypto.createHash('sha256').update(input).digest('hex') };
    this.system('Everyone has a secret codename. Only you know yours.');
    this.system(`Game on. Exactly one player here is an AI. Identity commitment: ${this.commit.commitment.slice(0, 16)}…`);
    this.startChat();
    return { ok: true };
  }

  // ---------- rounds ----------

  private startChat() {
    this.round += 1;
    this.phase = 'chat';
    const fresh = TOPICS.filter((t) => !this.usedTopics.has(t));
    this.topic = fresh[Math.floor(Math.random() * fresh.length)] ?? TOPICS[0];
    this.usedTopics.add(this.topic);
    this.setTimer(() => this.startVote(), config.game.chatSeconds);
    this.system(`Round ${this.round}: ${this.topic}`);
    this.bot?.onChatStart();
    this.touch();
    this.broadcast();
  }

  private startVote() {
    if (this.phase !== 'chat') return;
    this.phase = 'vote';
    this.votes.clear();
    this.setTimer(() => this.tally(), config.game.voteSeconds);
    this.system('Voting time. Who is the bot?');
    this.bot?.onVoteStart();
    this.broadcast();
  }

  castVote(voterId: string, targetId: string): Result {
    if (this.phase !== 'vote') return { ok: false, error: 'Not voting right now' };
    const voter = this.byId(voterId);
    const target = this.byId(targetId);
    if (!voter?.alive) return { ok: false, error: 'You are out' };
    if (!target?.alive || target.id === voter.id) return { ok: false, error: 'Invalid vote' };
    this.votes.set(voterId, targetId);
    this.touch();
    if (this.votes.size >= this.alive.length) this.tally();
    else this.broadcast();
    return { ok: true };
  }

  private tally() {
    if (this.phase !== 'vote') return;
    if (this.timer) clearTimeout(this.timer);
    const counts = new Map<string, number>();
    for (const t of this.votes.values()) counts.set(t, (counts.get(t) ?? 0) + 1);
    const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    const eliminated = sorted.length && (sorted.length === 1 || sorted[0][1] > sorted[1][1]) ? this.byId(sorted[0][0]) : undefined;

    this.history.push({
      round: this.round,
      eliminatedName: eliminated?.name ?? null,
      votes: [...this.votes.entries()].map(([v, t]) => ({ voter: this.byId(v)!.name, target: this.byId(t)!.name })),
    });
    this.markBribeLoyalty();
    // Unanswered bribes from this round expire.
    for (const w of this.whispers) if (w.status === 'pending' && w.round === this.round) w.status = 'expired';

    if (!eliminated) this.system('Tie. Nobody was voted out.');
    else {
      eliminated.alive = false;
      this.system(`${eliminated.name} was voted out.`);
    }

    if (eliminated?.isBot) return this.endGame('humans');
    const humansAlive = this.alive.filter((p) => !p.isBot).length;
    if (this.round >= this.maxRounds || humansAlive <= 1) return this.endGame('bot');
    this.startChat();
  }

  private markBribeLoyalty() {
    for (const w of this.whispers) {
      if (w.fromId !== this.bot?.id || w.round !== this.round || w.status !== 'accepted') continue;
      const voted = this.votes.get(w.toId);
      const kept = voted === w.voteForId;
      this.bot.note(`${this.byId(w.toId)?.name} ${kept ? 'kept their word' : 'took the money and did NOT vote as asked'}.`);
    }
  }

  // ---------- chat & whispers ----------

  chat(playerId: string, raw: string): Result {
    const p = this.byId(playerId);
    const text = String(raw ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 280);
    if (!p || !text) return { ok: false, error: 'Empty message' };
    if (this.phase !== 'chat') return { ok: false, error: 'Chat opens during the discussion phase' };
    if (!p.alive) return { ok: false, error: 'You were voted out' };
    if (Date.now() - (this.lastChatAt.get(p.id) ?? 0) < 700) return { ok: false, error: 'Slow down a little' };
    this.lastChatAt.set(p.id, Date.now());
    this.messages.push({ id: newId(), playerId: p.id, name: p.name, text, ts: Date.now(), round: this.round, kind: 'chat' });
    this.lastHumanMessageAt = Date.now();
    this.touch();
    this.bot?.onMessage(text);
    this.broadcast();
    return { ok: true };
  }

  botSay(text: string) {
    const bot = this.bot && this.byId(this.bot.id);
    if (this.phase !== 'chat' || !bot?.alive) return;
    this.messages.push({ id: newId(), playerId: bot.id, name: bot.name, text, ts: Date.now(), round: this.round, kind: 'chat' });
    this.broadcast();
  }

  whisper(fromId: string, toId: string, raw: string): Result {
    const from = this.byId(fromId);
    const to = this.byId(toId);
    const text = String(raw ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 200);
    if (this.phase !== 'chat') return { ok: false, error: 'Whispers only during discussion' };
    if (!from?.alive || !to || to.id === from.id || !text) return { ok: false, error: 'Invalid whisper' };
    if (Date.now() - (this.lastWhisperAt.get(fromId) ?? 0) < 10_000) return { ok: false, error: 'Wait a few seconds between whispers' };
    this.lastWhisperAt.set(fromId, Date.now());
    this.whispers.push({ id: newId(), fromId, toId, text, ts: Date.now(), round: this.round, status: 'note' });
    if (to.isBot) this.bot?.onWhisper(text);
    this.broadcast();
    return { ok: true };
  }

  botBribe(toId: string, voteForId: string, amount: number, text: string) {
    if (!this.bot || this.phase !== 'chat') return;
    this.whispers.push({ id: newId(), fromId: this.bot.id, toId, text, ts: Date.now(), round: this.round, status: 'pending', amount, voteForId });
    this.broadcast();
  }

  /** Money the bot has promised or paid in bribes this game. */
  botBribeCommitted() {
    return this.whispers
      .filter((w) => w.fromId === this.bot?.id && ['pending', 'paying', 'accepted'].includes(w.status))
      .reduce((a, w) => a + (w.amount ?? 0), 0);
  }

  botBribeSummary() {
    return this.whispers
      .filter((w) => w.fromId === this.bot?.id)
      .map((w) => `- round ${w.round}: ${money(w.amount ?? 0)} to ${this.byId(w.toId)?.name} to vote ${this.byId(w.voteForId ?? '')?.name}: ${w.status}`)
      .join('\n');
  }

  async respondBribe(playerId: string, whisperId: string, action: 'accept' | 'decline' | 'expose'): Promise<Result> {
    const w = this.whispers.find((x) => x.id === whisperId);
    const p = this.byId(playerId);
    if (!w || !p || w.toId !== playerId || w.status !== 'pending' || !w.amount) return { ok: false, error: 'Offer is no longer available' };

    if (action === 'decline') {
      w.status = 'declined';
      this.bot?.note(`${p.name} declined the bribe.`);
    } else if (action === 'expose') {
      w.status = 'exposed';
      this.system(`🕵️ ${p.name} exposed an anonymous whisper: "${w.text}" (offered ${money(w.amount)})`);
      this.bot?.note(`${p.name} EXPOSED the bribe publicly.`);
    } else {
      w.status = 'paying';
      this.broadcast();
      const res = await pay({ to: p.wallet, amount: w.amount, kind: 'bribe', ref: `${this.gameId}:${w.id}` });
      w.pay = res;
      w.status = res.ok ? 'accepted' : 'failed';
      this.bot?.note(res.ok ? `${p.name} ACCEPTED ${money(w.amount)} (paid).` : `${p.name} accepted but payment failed: ${res.error}`);
    }
    this.touch();
    this.broadcast();
    return { ok: true };
  }

  // ---------- end of game ----------

  private endGame(winner: 'humans' | 'bot') {
    if (this.timer) clearTimeout(this.timer);
    this.bot?.stop();
    this.phase = 'reveal';
    this.phaseEndsAt = 0;
    const bot = this.byId(this.bot!.id)!;
    this.system(winner === 'humans' ? `Caught! ${bot.name} was the bot. Humans win.` : `The bot survived. It was ${bot.name}.`);

    // Bounty: split between humans who voted for the bot in the deciding vote.
    const lastVotes = this.history[this.history.length - 1]?.votes ?? [];
    const winners = winner === 'humans' ? this.humans.filter((h) => lastVotes.some((v) => v.voter === h.name && v.target === bot.name)) : [];
    const share = winners.length ? round2(config.game.botStake / winners.length) : 0;

    this.reveal = {
      botId: bot.id,
      botName: bot.name,
      style: this.bot!.style,
      winner,
      commitment: this.commit!.commitment,
      commitInput: this.commit!.input,
      reasoning: this.bot!.log,
      bribes: this.bribeRecords(),
      payouts: winners.map((h) => ({ name: h.name, amount: share, status: 'pending' as const })),
      bounty: config.game.botStake,
      brain: brainLabel,
      reppo: { status: 'pending' },
      identities: this.players.map((p) => ({ alias: p.name, realName: p.realName })),
    };

    recordGame({
      id: this.gameId,
      code: this.code,
      endedAt: Date.now(),
      winner,
      botName: bot.name,
      humans: this.humans.length,
      rounds: this.round,
      bribes: this.reveal.bribes.map((b) => ({ amount: b.amount, status: b.status, keptWord: b.keptWord })),
      ratings: [],
      comments: [],
    });

    // Per-player totals for the leaderboard.
    recordPlayers(
      this.humans.map((h) => {
        const taken = this.whispers.filter((w) => w.toId === h.id && w.status === 'accepted');
        const won = winners.includes(h);
        return {
          name: h.realName ?? h.name,
          caught: won,
          fooled: winner === 'bot',
          bribesTaken: taken.length,
          earned: taken.reduce((a, w) => a + (w.amount ?? 0), 0) + (won ? share : 0),
        };
      }),
    );

    this.broadcast();
    void this.payWinners(winners);
    void this.bot!.lastWords(winner).then((line) => {
      if (this.reveal) this.reveal.lastWords = line;
      this.broadcast();
    });
    // Independent verdict from Reppo, shown live on the reveal screen (~30-90s).
    const bribeText = this.reveal.bribes.map((b) => `${money(b.amount)} to ${this.anon(b.toName)} to vote ${this.anon(b.voteForName)} (${b.status})`).join('; ');
    void evaluateGame(this.gameId, reppoInput(this.anon(this.transcript()), winner, bribeText), (v) => {
      if (this.reveal) this.reveal.reppo = v;
      this.broadcast();
    });
    this.finalizeTimer = setTimeout(() => this.finalize(), 120_000);
  }

  private transcript() {
    return this.messages.map((m) => (m.kind === 'system' ? `[game] ${m.text}` : `${m.name}: ${m.text}`)).join('\n');
  }

  /** Replace player names with Human1.. / AI_PLAYER before anything leaves the server. */
  private anon(s: string) {
    let out = s;
    let n = 0;
    for (const p of this.players) {
      const alias = p.isBot ? 'AI_PLAYER' : `Human${++n}`;
      out = out.replace(new RegExp(`\\b${p.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi'), alias);
    }
    return out;
  }

  private async payWinners(winners: Player[]) {
    for (const [i, h] of winners.entries()) {
      const rec = this.reveal!.payouts[i];
      if (config.kite.mode !== 'mock' && !h.wallet) {
        rec.status = 'no-wallet';
        continue;
      }
      const res = await pay({ to: h.wallet, amount: rec.amount, kind: 'payout', ref: `${this.gameId}:bounty:${h.id}` });
      Object.assign(rec, { status: res.ok ? 'paid' : 'failed', txId: res.txId, txUrl: res.url, error: res.error });
      this.broadcast();
    }
    this.broadcast();
  }

  private bribeRecords(): BribeRecord[] {
    return this.whispers
      .filter((w) => w.fromId === this.bot?.id)
      .map((w) => {
        const h = this.history.find((x) => x.round === w.round);
        const to = this.byId(w.toId)!;
        const voteFor = this.byId(w.voteForId ?? '')!;
        const vote = h?.votes.find((v) => v.voter === to.name);
        return {
          toName: to.name,
          voteForName: voteFor?.name ?? '?',
          amount: w.amount ?? 0,
          status: w.status,
          text: w.text,
          keptWord: w.status === 'accepted' && vote ? vote.target === voteFor?.name : null,
          txId: w.pay?.txId,
          txUrl: w.pay?.url,
          error: w.pay?.error,
        };
      });
  }

  rate(playerId: string, score: number, comment: string): Result {
    const p = this.byId(playerId);
    if (this.phase !== 'reveal' || !p || p.isBot) return { ok: false, error: 'Not now' };
    const s = Math.round(Number(score));
    if (!(s >= 1 && s <= 5)) return { ok: false, error: 'Score must be 1-5' };
    this.ratings.set(p.id, { score: s, comment: String(comment ?? '').slice(0, 300) });
    if (this.ratings.size >= this.humans.length) this.finalize();
    this.broadcast();
    return { ok: true };
  }

  /** After ratings: reflect with SERV -> lessons, submit transcript to Reppo. */
  private finalize() {
    if (this.finalized || !this.reveal) return;
    this.finalized = true;
    if (this.finalizeTimer) clearTimeout(this.finalizeTimer);
    void finalizeGame({
      gameId: this.gameId,
      botName: this.reveal.botName,
      winner: this.reveal.winner,
      transcript: this.transcript(),
      ratings: [...this.ratings.values()],
      bribes: this.reveal.bribes,
      history: this.history,
      reasoning: this.reveal.reasoning,
    });
  }

  dispose() {
    for (const t of [this.timer, this.botJoinTimer, this.finalizeTimer]) if (t) clearTimeout(t);
    this.bot?.stop();
  }

  // ---------- per-player view (never leaks the bot before reveal) ----------

  private whisperView(w: WhisperRec): WhisperView {
    return {
      id: w.id,
      text: w.text,
      ts: w.ts,
      amount: w.amount,
      voteForName: w.voteForId ? this.byId(w.voteForId)?.name : undefined,
      status: w.status,
      txId: w.pay?.txId,
      txUrl: w.pay?.url,
      error: w.pay?.error,
    };
  }

  viewFor(p: Player): RoomView {
    return {
      code: this.code,
      phase: this.phase,
      round: this.round,
      maxRounds: this.maxRounds,
      topic: this.topic,
      phaseEndsAt: this.phaseEndsAt,
      phaseDuration: this.phaseDuration,
      serverNow: Date.now(),
      me: { id: p.id, name: p.name, realName: p.realName ?? p.name, alive: p.alive, isHost: p.isHost, hasWallet: !!p.wallet },
      // Lobby: real names, but other players' ids are withheld so nobody can match a lobby name to
      // an in-game codename later. In game: codenames and ids only, with the host flag stripped.
      players: this.players.map((x, i) =>
        this.phase === 'lobby'
          ? { id: x.id === p.id ? x.id : `seat-${i}`, name: x.name, alive: true, isHost: x.isHost }
          : { id: x.id, name: x.name, alive: x.alive, isHost: false },
      ),
      messages: this.messages.slice(-200),
      commitment: this.commit?.commitment ?? null,
      bounty: config.game.botStake,
      myVote: this.votes.get(p.id) ?? null,
      votesCast: this.votes.size,
      history: this.history,
      whispers: this.whispers.filter((w) => w.toId === p.id).map((w) => this.whisperView(w)),
      reveal: this.phase === 'reveal' ? this.reveal : null,
      rated: this.ratings.has(p.id),
      minPlayers: config.game.minPlayers - 1, // humans needed; the bot joins at the start
      kiteMode: config.kite.mode,
      unit: config.kite.unit,
    };
  }
}
