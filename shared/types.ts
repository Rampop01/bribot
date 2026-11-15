// Types shared by the server and the browser client.

export type Phase = 'lobby' | 'chat' | 'vote' | 'reveal';

export interface PublicPlayer {
  id: string;
  name: string;
  alive: boolean;
  isHost: boolean;
}

export interface ChatMsg {
  id: string;
  playerId: string | null;
  name: string;
  text: string;
  ts: number;
  round: number;
  kind: 'chat' | 'system';
}

export type WhisperStatus =
  | 'note' // plain anonymous whisper, no money attached
  | 'pending' // bribe offered, waiting for the recipient
  | 'paying' // recipient accepted, payment in flight
  | 'accepted' // paid
  | 'declined'
  | 'exposed'
  | 'expired'
  | 'failed'; // accepted but the payment failed

export interface WhisperView {
  id: string;
  text: string;
  ts: number;
  amount?: number;
  voteForName?: string;
  status: WhisperStatus;
  txUrl?: string;
  txId?: string;
  error?: string;
}

export interface RoundResult {
  round: number;
  eliminatedName: string | null;
  votes: { voter: string; target: string }[];
}

export interface ReasoningEntry {
  ts: number;
  round: number;
  phase: Phase;
  kind: 'say' | 'quiet' | 'bribe' | 'vote' | 'note';
  reasoning: string;
  detail?: string;
}

export interface BribeRecord {
  toName: string;
  voteForName: string;
  amount: number;
  status: WhisperStatus;
  text: string;
  keptWord: boolean | null; // did the recipient vote as asked?
  txUrl?: string;
  txId?: string;
  error?: string;
}

export interface PayoutRecord {
  name: string;
  amount: number;
  status: 'pending' | 'paid' | 'failed' | 'no-wallet';
  txUrl?: string;
  txId?: string;
  error?: string;
}

export interface ReppoView {
  status: 'disabled' | 'pending' | 'completed' | 'failed';
  score?: number;
  decision?: string;
  route?: string;
  confidence?: string;
  reason?: string;
  rubric?: Record<string, number>;
  error?: string;
}

export interface RevealData {
  botId: string;
  botName: string;
  style: string;
  winner: 'humans' | 'bot';
  commitment: string;
  commitInput: string;
  reasoning: ReasoningEntry[];
  bribes: BribeRecord[];
  payouts: PayoutRecord[];
  bounty: number;
  brain: string; // which model/provider powered the bot
  reppo: ReppoView;
  identities: { alias: string; realName: string | null }[]; // who was behind each codename (null = the bot)
  lastWords?: string; // the bot's parting line, written by SERV Reasoning
}

export interface RoomView {
  code: string;
  phase: Phase;
  round: number;
  maxRounds: number;
  topic: string;
  phaseEndsAt: number;
  phaseDuration: number; // seconds
  serverNow: number;
  me: { id: string; name: string; realName: string; alive: boolean; isHost: boolean; hasWallet: boolean };
  players: PublicPlayer[];
  messages: ChatMsg[];
  commitment: string | null;
  bounty: number;
  myVote: string | null;
  votesCast: number;
  history: RoundResult[];
  whispers: WhisperView[];
  reveal: RevealData | null;
  rated: boolean;
  minPlayers: number;
  kiteMode: string;
  unit: string; // '$' or a coin symbol such as 'KITE'
}

export type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };

export interface Session {
  code: string;
  playerId: string;
  token: string;
}

export interface StatsGame {
  id: string;
  endedAt: number;
  winner: 'humans' | 'bot';
  botName: string;
  humans: number;
  rounds: number;
  bribesOffered: number;
  bribesAccepted: number;
  bribeSpend: number;
  avgRating: number | null;
  reppoScore: number | null;
  reppoStatus: string | null;
}

export interface PlayerStat {
  name: string;
  games: number;
  caught: number; // games where this player voted the bot out
  fooled: number; // games the bot survived
  bribesTaken: number;
  earned: number;
}

export interface Stats {
  leaderboard: PlayerStat[];
  games: StatsGame[];
  survivalRate: number | null;
  avgRating: number | null;
  avgReppo: number | null;
  totalSpent: number;
  unit: string;
  lessons: { text: string; source: string; ts: number }[];
  integrations: { serv: string; kite: string; reppo: string };
}
