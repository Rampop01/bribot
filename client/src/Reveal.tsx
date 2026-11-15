import { useEffect, useState } from 'react';
import type { ReppoView, RoomView } from '../../shared/types';
import Outcome from './Outcome';
import { emit, fmt, sha256hex } from './socket';

const KIND_ICON: Record<string, string> = { say: '💬', quiet: '🤫', bribe: '💸', vote: '🗳️', note: '📝' };

export default function Reveal({ view, onLeave }: { view: RoomView; onLeave: () => void }) {
  const r = view.reveal!;
  const [verified, setVerified] = useState<null | boolean | 'unsupported'>(null);
  const [score, setScore] = useState(0);
  const [comment, setComment] = useState('');

  const verify = async () => {
    const h = await sha256hex(r.commitInput);
    setVerified(h === null ? 'unsupported' : h === r.commitment);
  };

  return (
    <div className="reveal">
      <Outcome view={view} />
      <div className={`revealhero ${r.winner}`}>
        <div className="kicker">{r.winner === 'humans' ? 'Humans win' : 'The bot survived'}</div>
        <h1 className="title">
          The bot was{' '}
          <span className="glitch" data-text={r.botName}>
            {r.botName}
          </span>
        </h1>
        <div className="muted small">
          Brain: {r.brain} · persona: {r.style}
        </div>
        {r.lastWords && (
          <div className="lastwords">
            <span>{r.botName}'s last words</span>“{r.lastWords}”
          </div>
        )}
      </div>

      <div className="grid2">
        <div className="col">
          <section className="card glass enter">
            <h3>🎭 Who was who</h3>
            <div className="idgrid">
              {r.identities.map((i) => (
                <div key={i.alias} className={i.realName ? '' : 'isbot'}>
                  <b>{i.alias}</b>
                  <span>{i.realName ?? '🤖 the bot'}</span>
                </div>
              ))}
            </div>
          </section>

          <section className="card glass enter">
            <h3>📊 Reppo verdict</h3>
            <Reppo v={r.reppo} />
          </section>

          <section className="card glass enter" style={{ animationDelay: '80ms' }}>
            <h3>💰 Money moved by the agent</h3>
            {r.bribes.length === 0 && r.payouts.length === 0 && <p className="muted small">No money moved this game.</p>}
            {r.bribes.map((b, i) => (
              <div key={i} className="ledger">
                <b className="money">{fmt(b.amount, view.unit)}</b> bribe to {b.toName} to vote {b.voteForName}: <i>{b.status}</i>
                {b.keptWord === true && ' · kept their word'}
                {b.keptWord === false && ' · betrayed the bot 😈'}
                {b.txUrl && (
                  <>
                    {' · '}
                    <a href={b.txUrl} target="_blank" rel="noreferrer">
                      tx
                    </a>
                  </>
                )}
                <div className="small muted">“{b.text}”</div>
              </div>
            ))}
            {r.payouts.map((p, i) => (
              <div key={i} className="ledger">
                <b className="money">{fmt(p.amount, view.unit)}</b> bounty to {p.name}: <i>{p.status}</i>
                {p.txUrl && (
                  <>
                    {' · '}
                    <a href={p.txUrl} target="_blank" rel="noreferrer">
                      tx
                    </a>
                  </>
                )}
                {p.error && <span className="error small"> {p.error}</span>}
              </div>
            ))}
            {view.kiteMode === 'mock' && <p className="muted small">Kite is in mock mode: payments are simulated.</p>}
          </section>

          <section className="card glass enter" style={{ animationDelay: '160ms' }}>
            <h3>🔒 Provably fair</h3>
            <p className="small muted">This hash of the bot's identity was published before the first message. Recompute it yourself.</p>
            <code className="block">sha256("{r.commitInput}")</code>
            <code className="block">= {r.commitment}</code>
            <button onClick={verify}>Verify in my browser</button>
            {verified === true && <p className="ok">✓ Matches. The bot was locked in before the game started.</p>}
            {verified === false && <p className="error">✗ Mismatch!</p>}
            {verified === 'unsupported' && <p className="muted small">This browser blocks hashing on plain http. In a terminal: echo -n "…" | shasum -a 256</p>}
          </section>

          <section className="card glass enter" style={{ animationDelay: '240ms' }}>
            <h3>⭐ How human did {r.botName} feel?</h3>
            {view.rated ? (
              <p className="ok">Thanks. Your rating trains the bot's next game.</p>
            ) : (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  if (score) void emit('rate', { score, comment });
                }}
              >
                <div className="stars">
                  {[1, 2, 3, 4, 5].map((n) => (
                    <button type="button" key={n} className={n <= score ? 'on' : ''} onClick={() => setScore(n)}>
                      ★
                    </button>
                  ))}
                </div>
                <input value={comment} maxLength={300} onChange={(e) => setComment(e.target.value)} placeholder="What gave it away? (optional)" />
                <button className="primary" disabled={!score}>
                  Submit rating
                </button>
              </form>
            )}
          </section>
        </div>

        <section className="card glass enter" style={{ animationDelay: '120ms' }}>
          <h3>🧠 The bot's hidden reasoning</h3>
          <div className="timeline">
            {r.reasoning.map((e, i) => (
              <div key={i} className={`tl ${e.kind}`} style={{ animationDelay: `${Math.min(i, 20) * 70}ms` }}>
                <div className="small muted">
                  {KIND_ICON[e.kind]} R{e.round} · {e.phase} · {new Date(e.ts).toLocaleTimeString()}
                </div>
                <div>{e.reasoning}</div>
                {e.detail && <div className="detail">{e.detail}</div>}
              </div>
            ))}
          </div>
        </section>
      </div>

      <div className="row centerrow">
        <button className="primary big" onClick={onLeave}>
          Play again
        </button>
        <a href="#stats">Bot learning stats →</a>
      </div>
    </div>
  );
}

/** Independent score from Reppo's evaluator panel; arrives ~30-90s after the game ends. */
function Reppo({ v }: { v: ReppoView }) {
  const [shown, setShown] = useState(0);
  const score = v.status === 'completed' ? Math.round(v.score ?? 0) : 0;
  useEffect(() => {
    if (!score) return;
    let raf = 0;
    const t0 = performance.now();
    const tick = (t: number) => {
      const k = Math.min(1, (t - t0) / 1200);
      setShown(Math.round(score * (1 - Math.pow(1 - k, 3))));
      if (k < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [score]);

  if (v.status === 'disabled') return <p className="muted small">Reppo is not configured on this server.</p>;
  if (v.status === 'failed') return <p className="muted small">Evaluation failed: {v.error}</p>;
  if (v.status === 'pending')
    return (
      <div className="reppo pending">
        <div className="spinner" />
        <div>
          <b>Independent evaluators are scoring the bot…</b>
          <div className="muted small">Usually takes 30 to 90 seconds.</div>
        </div>
      </div>
    );

  const C = Math.PI * 54; // half circle
  return (
    <div className="reppo">
      <div className="gauge">
        <svg viewBox="0 0 128 74">
          <path d="M10 68 A54 54 0 0 1 118 68" className="track" />
          <path d="M10 68 A54 54 0 0 1 118 68" className="prog" strokeDasharray={C} strokeDashoffset={C * (1 - shown / 100)} />
        </svg>
        <div className="num">{shown}</div>
        <div className="small muted">out of 100</div>
      </div>
      <div className="reppotext">
        <div className="chips">
          {v.decision && <span>{v.decision}</span>}
          {v.confidence && <span>{v.confidence} confidence</span>}
          {v.rubric && Object.entries(v.rubric).map(([k, n]) => <span key={k}>{k} {n}</span>)}
        </div>
        <p className="small">{v.reason?.replace(/\*\*/g, '')}</p>
      </div>
    </div>
  );
}
