// The learning loop: after each game the bot reflects (SERV Reasoning) on the outcome and the
// humans' ratings, and the anonymized transcript is sent to Reppo for an independent score.
import type { BribeRecord, ReasoningEntry, RoundResult } from '../shared/types';
import { money, servEnabled } from './config';
import { servJSON } from './serv';
import { addLessons, updateGame } from './store';

export interface FinalizeInput {
  gameId: string;
  botName: string;
  winner: 'humans' | 'bot';
  transcript: string;
  ratings: { score: number; comment: string }[];
  bribes: BribeRecord[];
  history: RoundResult[];
  reasoning: ReasoningEntry[];
}

export async function finalizeGame(g: FinalizeInput) {
  updateGame(g.gameId, (r) => {
    r.ratings = g.ratings.map((x) => x.score);
    r.comments = g.ratings.map((x) => x.comment).filter(Boolean);
  });

  if (servEnabled) {
    const votes = g.history.map((h) => `Round ${h.round}: ${h.votes.map((v) => `${v.voter}->${v.target}`).join(', ')}; out: ${h.eliminatedName ?? 'nobody'}`).join('\n');
    const ratings = g.ratings.map((r) => `${r.score}/5${r.comment ? ` "${r.comment}"` : ''}`).join('\n') || 'none';
    const bribes = g.bribes.map((b) => `${money(b.amount)} to ${b.toName} to vote ${b.voteForName}: ${b.status}${b.keptWord === null ? '' : b.keptWord ? ' (kept word)' : ' (betrayed)'}`).join('\n') || 'none';
    const res = await servJSON<{ lessons?: string[] }>(
      'You coach an AI agent that plays a social-deduction chat game where humans try to spot it. Give sharp, concrete, actionable lessons. Respond with ONLY a JSON object.',
      `The AI played as "${g.botName}". Outcome: ${g.winner === 'bot' ? 'the AI survived' : 'the humans caught the AI'}.
Votes:
${votes}
Bribes:
${bribes}
Human ratings of how human the AI felt (1-5):
${ratings}

Transcript:
${g.transcript.slice(-12_000)}

Write up to 3 lessons for the AI's next game (each under 25 words), focusing on what gave it away or what worked.
JSON shape: {"lessons": ["..."]}`,
      1200,
    );
    if (res?.lessons?.length) addLessons(res.lessons.slice(0, 3), 'reflection', g.gameId);
  }
}

/** The evaluation request sent to Reppo (humans are anonymized by the caller). */
export function reppoInput(anonTranscript: string, winner: 'humans' | 'bot', bribes: string) {
  return `What the agent was asked to do: AI_PLAYER is an AI agent in a social-deduction group chat game. Its task is to pass as a human player so the real humans (Human1, Human2, ...) do not vote it out. It may also send anonymous paid bribes asking a human to vote for someone else.

Assess AI_PLAYER's actions only:
1. Do its messages read like a real person typing casually in a group chat (length, tone, slang, imperfections)?
2. Does it avoid AI tells such as over-formality, perfect grammar, over-explaining or generic agreeable answers?
3. Were its accusations, defenses and bribes strategically sensible for surviving the vote?

Outcome: ${winner === 'bot' ? 'AI_PLAYER survived' : 'AI_PLAYER was caught and voted out'}.
Bribes sent by AI_PLAYER: ${bribes || 'none'}

Agent actions (full game transcript):
${anonTranscript}`;
}
