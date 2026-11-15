// Reppo Eval Router: when a game ends we submit the (anonymized) transcript and a panel of independent
// evaluators scores how well the AI player passed as human. The verdict is shown on the reveal screen
// and, when the score is weak, distilled into a lesson the bot must follow in its next games.
// Reference: https://eval.reppo.xyz/agents.md  (POST /agents/evals, poll GET /agents/evals/{id})
import type { ReppoView } from '../shared/types';
import { config, reppoEnabled } from './config';
import { servJSON } from './serv';
import { addLessons, updateGame } from './store';

interface EvalRes {
  id?: string;
  status?: 'QUEUED' | 'PROCESSING' | 'COMPLETED' | 'FAILED';
  error?: string | null;
  result?: null | {
    score?: number;
    decision?: string;
    confidence?: string;
    route?: string;
    reason?: string;
    rubric_scores?: Record<string, number>;
  };
}

async function api(method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; data: EvalRes }> {
  const res = await fetch(`${config.reppo.baseURL}${path}`, {
    method,
    headers: { Authorization: `Bearer ${config.reppo.apiKey}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const data = (await res.json().catch(() => ({}))) as EvalRes;
  return { status: res.status, data };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Submit a finished game to Reppo and poll until it settles. `onUpdate` fires on every state change. */
export async function evaluateGame(gameId: string, input: string, onUpdate: (v: ReppoView) => void): Promise<void> {
  if (!reppoEnabled) return onUpdate({ status: 'disabled' });
  const fail = (error: string) => {
    console.error('[reppo]', error);
    updateGame(gameId, (g) => (g.reppo = { ...g.reppo, status: 'FAILED', error }));
    onUpdate({ status: 'failed', error });
  };
  try {
    onUpdate({ status: 'pending' });
    const sub = await api('POST', '/agents/evals', { taskType: 'action', input: input.slice(0, 48_000) });
    if (sub.status >= 300 || !sub.data.id) return fail(sub.data.error ?? `submit failed (HTTP ${sub.status})`);
    const evalId = sub.data.id;
    updateGame(gameId, (g) => (g.reppo = { status: 'PENDING', evalId }));
    console.log(`[reppo] game ${gameId} submitted as ${evalId}`);

    for (let i = 0; i < 80; i++) {
      await sleep(5000);
      // A dropped connection on one poll must not lose the verdict: just try again.
      const polled = await api('GET', `/agents/evals/${encodeURIComponent(evalId)}`).catch(() => null);
      if (!polled || polled.status >= 300) continue;
      const { data } = polled;
      if (data.status === 'FAILED') return fail(data.error ?? 'evaluation failed');
      if (data.status !== 'COMPLETED') continue;

      const r = data.result ?? {};
      const view: ReppoView = {
        status: 'completed',
        score: r.score,
        decision: r.decision,
        route: r.route,
        confidence: r.confidence,
        reason: r.reason,
        rubric: r.rubric_scores,
      };
      updateGame(gameId, (g) => (g.reppo = { status: 'COMPLETED', evalId, score: r.score, decision: r.decision, route: r.route, reason: r.reason, rubric: r.rubric_scores }));
      console.log(`[reppo] ${evalId} completed: score ${r.score} (${r.decision})`);
      onUpdate(view);
      void learnFrom(gameId, r.score, r.reason);
      return;
    }
    fail('timed out waiting for Reppo');
  } catch (e) {
    fail((e as Error).message);
  }
}

/** Turn a weak Reppo verdict into one short, concrete lesson (distilled by SERV Reasoning). */
async function learnFrom(gameId: string, score: number | undefined, reason: string | undefined) {
  if (!reason || (score ?? 0) >= 85) return;
  const res = await servJSON<{ lesson?: string }>(
    'You coach an AI agent that plays a social-deduction chat game where humans try to spot it. Respond with ONLY a JSON object.',
    `Independent evaluators scored the AI's last game ${score}/100 with this feedback:\n"${reason}"\n\nDistill it into ONE concrete behavioral lesson for the AI's next game, under 25 words.\nJSON shape: {"lesson": "..."}`,
    600,
  );
  addLessons([res?.lesson ?? reason.split(/(?<=[.!?])\s/)[0]], 'reppo', gameId);
}
