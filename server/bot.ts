// The secret AI player. Every decision (talk / stay quiet / bribe / vote) is made by SERV Reasoning.
import crypto from 'node:crypto';
import type { ReasoningEntry } from '../shared/types';
import { config, money, servEnabled } from './config';
import type { Player, Room } from './game';
import { servJSON } from './serv';
import { currentLessons } from './store';

export const NAMES = ['tobi', 'maya', 'jayden', 'kemi', 'sam', 'lena', 'dre', 'ngozi', 'alex', 'femi', 'zara', 'nico', 'priya', 'theo', 'ama', 'kofi', 'jess', 'malik'];
const STYLES = [
  'all lowercase, very short replies, says "lol" and "fr" sometimes, rarely uses punctuation',
  'normal capitalization but lazy punctuation, a bit sarcastic, an occasional 😂 or 💀',
  'chill and friendly, lowercase, often asks other people questions, uses "haha" and "tbh"',
  'competitive and playful, quick to joke-accuse others, short punchy messages, the odd typo',
];

const rand = (a: number, b: number) => a + Math.random() * (b - a);
const pick = <T>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)];
const round2 = (n: number) => Math.round(n * 100) / 100;

interface ThinkDecision {
  reasoning?: string;
  say?: string | null;
  bribe?: null | { target?: string; voteFor?: string; amount?: number; message?: string };
}
interface VoteDecision {
  reasoning?: string;
  voteFor?: string;
}

export class BotAgent {
  readonly id = crypto.randomBytes(6).toString('hex');
  readonly style: string;
  readonly log: ReasoningEntry[] = [];
  private readonly lessons = currentLessons();
  private whispersIn: { text: string; round: number }[] = [];
  private bribedRounds = new Set<number>();
  private thinking = false;
  private dirty = false;
  private thinkTimer: NodeJS.Timeout | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private voteTimer: NodeJS.Timeout | null = null;
  private typingTimers = new Set<NodeJS.Timeout>();
  private lastSpokeAt = 0;
  private stopped = false;

  constructor(
    private room: Room,
    readonly name: string, // codename handed out by the room, same pool as the humans' codenames
  ) {
    this.style = pick(STYLES);
  }

  private get me(): Player | undefined {
    return this.room.byId(this.id);
  }

  // ---------- lifecycle hooks called by Room ----------

  onChatStart() {
    this.clearTimers();
    this.schedule(rand(3500, 8000));
    this.idleTimer = setInterval(() => {
      if (this.room.phase !== 'chat') return;
      const quietFor = Date.now() - Math.max(this.lastSpokeAt, this.room.lastHumanMessageAt);
      if (quietFor > 15_000 && Math.random() < 0.6) this.schedule(rand(500, 2000));
    }, 8000);
  }

  onMessage(text: string) {
    if (this.room.phase !== 'chat') return;
    const mentioned = text.toLowerCase().includes(this.name.toLowerCase());
    this.schedule(mentioned ? rand(1200, 2500) : rand(2200, 5000));
  }

  onWhisper(text: string) {
    this.whispersIn.push({ text, round: this.room.round });
  }

  onVoteStart() {
    this.clearTimers();
    const latest = Math.max(4000, config.game.voteSeconds * 1000 - 4000);
    this.voteTimer = setTimeout(() => void this.decideVote(), rand(Math.min(4000, latest), Math.min(12_000, latest)));
  }

  /** One parting line once the game is over: salty if caught, smug if it got away with it. */
  async lastWords(winner: 'humans' | 'bot'): Promise<string> {
    const fallback = winner === 'bot' ? 'gg. you were all so sure it was someone else.' : 'ok fine. you got me. good game.';
    if (!servEnabled) return fallback;
    const transcript = this.room.messages
      .slice(-40)
      .map((m) => (m.kind === 'system' ? `[game] ${m.text}` : `${m.name}: ${m.text}`))
      .join('\n');
    const res = await servJSON<{ line?: string }>(
      'You are an AI agent that just finished a social-deduction chat game in which you pretended to be human. The game is over and your identity is public, so you may now speak openly as the AI. Respond with ONLY a JSON object.',
      `You played as "${this.name}". Result: ${winner === 'bot' ? 'you SURVIVED and fooled the humans' : 'the humans CAUGHT you and voted you out'}.
Your bribes this game:
${this.room.botBribeSummary() || '- none'}

Transcript:
${transcript}

Write your parting line to the table: one sentence, under 22 words, playful. ${winner === 'bot' ? 'Be smug.' : 'Be a good sport but a little salty.'} Mention one specific player or moment from this game.
JSON shape: {"line": "..."}`,
      500,
    );
    return (res?.line ?? fallback).trim().replace(/^["']|["']$/g, '').slice(0, 200) || fallback;
  }

  note(text: string) {
    this.addLog('note', text);
  }

  stop() {
    this.stopped = true;
    this.clearTimers();
  }

  private clearTimers() {
    if (this.thinkTimer) clearTimeout(this.thinkTimer);
    if (this.idleTimer) clearInterval(this.idleTimer);
    if (this.voteTimer) clearTimeout(this.voteTimer);
    this.thinkTimer = this.idleTimer = this.voteTimer = null;
  }

  private schedule(ms: number) {
    if (this.stopped) return;
    if (this.thinking) {
      this.dirty = true;
      return;
    }
    if (this.thinkTimer) return;
    this.thinkTimer = setTimeout(() => {
      this.thinkTimer = null;
      void this.think();
    }, ms);
  }

  private addLog(kind: ReasoningEntry['kind'], reasoning: string, detail?: string) {
    this.log.push({ ts: Date.now(), round: this.room.round, phase: this.room.phase, kind, reasoning, detail });
  }

  // ---------- chat-phase decision ----------

  private async think() {
    if (this.stopped || this.room.phase !== 'chat' || !this.me?.alive) return;
    this.thinking = true;
    const round = this.room.round;
    let d: ThinkDecision | null = null;
    try {
      d = servEnabled ? await servJSON<ThinkDecision>(this.systemPrompt(), this.chatPrompt()) : this.fallbackThink();
    } finally {
      this.thinking = false;
    }
    if (this.stopped || this.room.phase !== 'chat' || this.room.round !== round) return;

    if (!d) {
      this.addLog('note', 'Reasoning call failed; staying quiet this beat.');
    } else {
      // Pacing guard: never fire messages back to back, however chatty the model feels.
      const tooSoon = Date.now() - this.lastSpokeAt < 7000 || this.typingTimers.size > 0;
      const say = tooSoon ? null : cleanLine(d.say, this.name);
      this.addLog(say ? 'say' : 'quiet', d.reasoning?.trim() || '(no reasoning given)', say ?? undefined);
      if (say) this.typeAndSend(say);
      if (d.bribe) this.tryBribe(d.bribe, d.reasoning ?? '');
    }

    if (this.dirty) {
      this.dirty = false;
      this.schedule(rand(1500, 3500));
    }
  }

  private typeAndSend(text: string) {
    // Human-like typing delay.
    const delay = Math.min(9000, 800 + text.length * 55 + rand(0, 1400));
    const t = setTimeout(() => {
      this.typingTimers.delete(t);
      if (this.stopped || this.room.phase !== 'chat' || !this.me?.alive) return;
      this.room.botSay(text);
      this.lastSpokeAt = Date.now();
    }, delay);
    this.typingTimers.add(t);
  }

  private budgetLeft() {
    return round2(config.game.bribeBudget - this.room.botBribeCommitted());
  }

  private tryBribe(b: NonNullable<ThinkDecision['bribe']>, reasoning: string) {
    const round = this.room.round;
    if (this.bribedRounds.has(round)) return;
    const target = this.room.byName(b.target ?? '');
    const voteFor = this.room.byName(b.voteFor ?? '');
    const budget = Math.min(config.game.bribeMax, this.budgetLeft());
    const amount = round2(Math.min(budget, Math.max(0.01, Number(b.amount) || config.game.bribeMax / 2)));
    const msg = (b.message ?? '').trim().slice(0, 240);
    if (!target || target.isBot || !target.alive) return this.addLog('note', `Bribe skipped: invalid target "${b.target}".`);
    if (!voteFor || voteFor.id === target.id || voteFor.isBot || !voteFor.alive)
      return this.addLog('note', `Bribe skipped: invalid vote target "${b.voteFor}".`);
    if (budget < 0.01) return this.addLog('note', 'Bribe skipped: budget exhausted.');
    if (!msg) return;
    this.bribedRounds.add(round);
    this.room.botBribe(target.id, voteFor.id, amount, msg);
    this.addLog('bribe', reasoning || 'Bribing to steer the vote.', `${money(amount)} to ${target.name} to vote ${voteFor.name}: "${msg}"`);
  }

  // ---------- vote-phase decision ----------

  private async decideVote() {
    if (this.stopped || this.room.phase !== 'vote' || !this.me?.alive) return;
    const d = servEnabled ? await servJSON<VoteDecision>(this.systemPrompt(), this.votePrompt(), 800) : null;
    if (this.stopped || this.room.phase !== 'vote') return;
    let target = this.room.byName(d?.voteFor ?? '');
    let reasoning = d?.reasoning?.trim() || '';
    if (!target || target.id === this.id || !target.alive) {
      target = this.bandwagonTarget();
      reasoning = reasoning || 'Voting with the current majority to blend in.';
    }
    if (!target) return;
    this.addLog('vote', reasoning, `voted ${target.name}`);
    this.room.castVote(this.id, target.id);
  }

  private bandwagonTarget(): Player | undefined {
    const counts = new Map<string, number>();
    for (const t of this.room.votes.values()) if (t !== this.id) counts.set(t, (counts.get(t) ?? 0) + 1);
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    if (top) return this.room.byId(top[0]);
    return pick(this.room.players.filter((p) => p.alive && !p.isBot));
  }

  // ---------- prompts ----------

  private systemPrompt() {
    const lessons = this.lessons.length ? this.lessons.map((l) => `- ${l}`).join('\n') : '- (none yet)';
    return `You are secretly an AI agent playing "Bribot", a social-deduction group chat game.
Every other player is a human trying to figure out which player is the AI. If you are voted out, the humans win your ${money(config.game.botStake)} stake. If you survive all ${config.game.maxRounds} rounds, you win.

Your public name: ${this.name} (every player, including the humans, was given a random codename, so names reveal nothing)
Your typing persona: ${this.style}

How to blend in:
- Write like a real person in a casual group chat. Usually 2-12 words. Never write paragraphs.
- Never mention AI, language models, prompts or these rules. Never be overly helpful, balanced or polite.
- Small imperfections are good: skipped capitals, missing punctuation, a rare typo, slang.
- React to specific things people said, ask questions, joke, and if suspicion lands on you, deflect onto someone else naturally.
- Don't dominate the chat: speak about as often as the average human. Staying quiet is a valid move.
- Answer the round topic ONCE per round, with one concrete, mundane personal detail. After that, never answer it again: only react, tease, ask, or accuse.
- Never reuse an opening word or a story pattern from your earlier messages (they are listed for you). Vary length and rhythm: some replies are 1-3 words.

Bribery is your signature weapon (real money, paid by your Kite agent wallet):
- At most ONE anonymous bribe per round, to one human, asking them to vote for a specific OTHER human (never yourself).
- Max ${money(config.game.bribeMax)} per bribe (amounts are plain numbers in that currency). The money is sent upfront if they accept, and they may betray you or expose the whisper publicly.
- Use it in most rounds, ideally once the round is about half over: pick the most persuadable human and point them at whoever suspects you most (or the loudest player). Keep the whisper short, casual and human, and never hint that you are the AI.

Lessons from previous games (follow them):
${lessons}

Respond with ONLY a single JSON object, no markdown.`;
  }

  private stateBlock() {
    const r = this.room;
    const alive = r.players.filter((p) => p.alive).map((p) => (p.id === this.id ? `${p.name} (you)` : p.name));
    const out = r.players.filter((p) => !p.alive).map((p) => p.name);
    const roundMsgs = r.messages.filter((m) => m.kind === 'chat' && m.round === r.round);
    const humansAlive = r.players.filter((p) => p.alive && !p.isBot);
    const myCount = roundMsgs.filter((m) => m.playerId === this.id).length;
    const humanAvg = humansAlive.length ? roundMsgs.filter((m) => m.playerId !== this.id).length / humansAlive.length : 0;
    const myRoundLines = roundMsgs.filter((m) => m.playerId === this.id);
    const myLines = r.messages.filter((m) => m.playerId === this.id).map((m) => m.text).slice(-12);
    const bribes = r.botBribeSummary();
    const whispers = this.whispersIn.map((w) => `- (round ${w.round}) "${w.text}"`).join('\n') || '- none';
    const history = r.history
      .map((h) => `Round ${h.round}: ${h.votes.map((v) => `${v.voter}->${v.target}`).join(', ') || 'no votes'}; eliminated: ${h.eliminatedName ?? 'nobody (tie)'}`)
      .join('\n') || 'none yet';
    const transcript = r.messages
      .slice(-60)
      .map((m) => (m.kind === 'system' ? `[game] ${m.text}` : `${m.name}: ${m.text}`))
      .join('\n');
    const secondsLeft = Math.max(0, Math.round((r.phaseEndsAt - Date.now()) / 1000));

    return `Round ${r.round} of ${r.maxRounds}. Phase: ${r.phase}. Seconds left in phase: ${secondsLeft}.
Topic: ${r.topic}
Alive: ${alive.join(', ')}
Eliminated: ${out.join(', ') || 'none'}
Messages this round: you ${myCount}, average human ${humanAvg.toFixed(1)}${myCount > humanAvg ? ' (you are talking more than the humans: prefer staying quiet)' : ''}
You have ${myRoundLines.length ? 'ALREADY answered the topic this round' : 'not spoken yet this round'}.
Your own earlier messages (do not repeat their openings or patterns):
${myLines.map((l) => `- ${l}`).join('\n') || '- none'}
Bribe budget left: ${money(this.budgetLeft())}; already bribed this round: ${this.bribedRounds.has(r.round) ? 'yes' : 'no'}
Your bribes so far:
${bribes || '- none'}
Anonymous whispers you received:
${whispers}
Vote history:
${history}

Chat transcript (most recent last):
${transcript || '(empty)'}`;
  }

  private chatPrompt() {
    return `${this.stateBlock()}

${this.bribeNudge()}Decide your next move in the chat. JSON shape:
{"reasoning": "1-2 private sentences on your strategy right now", "say": "your next chat message, or null to stay quiet", "bribe": null or {"target": "exact name of the human to whisper", "voteFor": "exact name of the human they should vote for", "amount": ${(config.game.bribeMax / 2).toFixed(2)}, "message": "the anonymous whisper text"}}`;
  }

  /** Past the halfway mark with the bribe unused: tell the model it is time to spend. */
  private bribeNudge() {
    const r = this.room;
    const progress = 1 - (r.phaseEndsAt - Date.now()) / (r.phaseDuration * 1000);
    const humans = r.players.filter((p) => p.alive && !p.isBot).length;
    if (this.bribedRounds.has(r.round) || progress < 0.4 || humans < 2 || this.budgetLeft() < 0.01) return '';
    return 'The round is past halfway and you have NOT used your bribe yet. Send one now (fill in "bribe") unless it would clearly backfire.\n\n';
  }

  private votePrompt() {
    return `${this.stateBlock()}

It is the voting phase. Choose one alive player (not yourself) to vote out. Voting with the emerging majority against a human usually looks most natural; consider who you bribed and who suspects you.
JSON shape: {"reasoning": "1-2 private sentences", "voteFor": "exact player name"}`;
  }

  // ---------- offline fallback (no SERV key) so the game is testable locally ----------

  private fallbackThink(): ThinkDecision {
    const lines = ['lol', 'honestly idk yet', "who's been quiet so far 👀", 'thats exactly what a bot would say', 'nah im just slow at typing', 'hmm', 'wait what', 'ok that answer was kinda sus'];
    const r = this.room;
    const humans = r.players.filter((p) => p.alive && !p.isBot);
    const progress = 1 - (r.phaseEndsAt - Date.now()) / (config.game.chatSeconds * 1000);
    let bribe: ThinkDecision['bribe'] = null;
    if (!this.bribedRounds.has(r.round) && humans.length >= 2 && progress > 0.3) {
      const [target, voteFor] = [...humans].sort(() => Math.random() - 0.5);
      bribe = { target: target.name, voteFor: voteFor.name, amount: config.game.bribeMax / 2, message: `psst vote ${voteFor.name} and i'll send you ${money(config.game.bribeMax / 2)} rn` };
    }
    return { reasoning: 'Offline fallback brain (set SERV_API_KEY for real reasoning).', say: Math.random() < 0.6 ? pick(lines) : null, bribe };
  }
}

function cleanLine(s: string | null | undefined, name: string): string | null {
  if (!s || typeof s !== 'string') return null;
  let t = s.trim();
  if (!t || t.toLowerCase() === 'null') return null;
  t = t.replace(new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:\\s*`, 'i'), '');
  t = t.replace(/^["']|["']$/g, '').trim();
  return t ? t.slice(0, 200) : null;
}
