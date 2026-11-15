import { useEffect, useRef, useState } from 'react';
import type { RoomView, WhisperView } from '../../shared/types';
import { emit, fmt } from './socket';

function useCountdown(view: RoomView) {
  const offset = useRef(0);
  offset.current = view.serverNow - Date.now();
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, []);
  return Math.max(0, (view.phaseEndsAt - (now + offset.current)) / 1000);
}

export default function Game({ view }: { view: RoomView }) {
  const left = useCountdown(view);
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const chatRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    chatRef.current?.scrollTo({ top: chatRef.current.scrollHeight, behavior: 'smooth' });
  }, [view.messages.length]);

  const send = async () => {
    const t = text.trim();
    if (!t) return;
    setText('');
    const r = await emit('chat', { text: t });
    setError(r.ok ? '' : (r.error ?? ''));
  };

  const others = view.players.filter((p) => p.alive && p.id !== view.me.id);
  const pendingBribe = view.whispers.some((w) => w.status === 'pending' && w.amount);
  const frac = view.phaseDuration ? Math.min(1, left / view.phaseDuration) : 0;
  const C = 2 * Math.PI * 20;

  return (
    <div className={`game ph-${view.phase}`}>
      {pendingBribe && <div className="bribeglow" />}
      <PhaseBanner key={`${view.round}-${view.phase}`} view={view} />

      <header className="topbar glass">
        <div className={`ringtimer ${left <= 10 ? 'hot' : ''}`}>
          <svg viewBox="0 0 48 48">
            <circle cx="24" cy="24" r="20" className="track" />
            <circle cx="24" cy="24" r="20" className="prog" strokeDasharray={C} strokeDashoffset={C * (1 - frac)} />
          </svg>
          <span>{Math.ceil(left)}</span>
        </div>
        <div className="topicwrap">
          <div className="small muted">
            Round {view.round}/{view.maxRounds} · <b className="phasename">{view.phase === 'chat' ? 'Discuss' : 'Vote'}</b>
          </div>
          <div className="topic">{view.phase === 'vote' ? 'Who is the bot?' : view.topic}</div>
        </div>
        <div className="small muted right" title={`Identity commitment: ${view.commitment ?? ''}`}>
          <div>
            You are <b className="alias">{view.me.name}</b> · Bounty <b className="money">{fmt(view.bounty, view.unit)}</b>
          </div>
          <div>🔒 {view.commitment?.slice(0, 10)}…</div>
        </div>
      </header>

      <div className="stagecell">
        {view.phase === 'vote' && view.me.alive && <div className="stagehint">Click a player at the table to vote</div>}
        {view.history.length > 0 && (
          <div className="pastvotes glass">
            {view.history.map((h) => (
              <div key={h.round} className="small">
                <b>R{h.round}</b> {h.votes.map((v) => `${v.voter}→${v.target}`).join(' · ')} <span className="muted">out: {h.eliminatedName ?? 'nobody'}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <main className="chat glass">
        <div className="messages" ref={chatRef}>
          {view.messages.map((m) =>
            m.kind === 'system' ? (
              <div key={m.id} className="sys">
                {m.text}
              </div>
            ) : (
              <div key={m.id} className={`msg ${m.playerId === view.me.id ? 'mine' : ''}`}>
                <b>{m.name}</b>
                {m.text}
              </div>
            ),
          )}
        </div>

        {view.phase === 'chat' &&
          (view.me.alive ? (
            <form
              className="composer"
              onSubmit={(e) => {
                e.preventDefault();
                void send();
              }}
            >
              <input value={text} maxLength={280} onChange={(e) => setText(e.target.value)} placeholder="Say something human…" autoFocus />
              <button className="primary">Send</button>
            </form>
          ) : (
            <div className="muted composer">You were voted out. Watch and judge.</div>
          ))}

        {view.phase === 'vote' && (
          <div className="votebox">
            {view.me.alive ? (
              <>
                <div className="small muted">
                  {view.votesCast} of {view.players.filter((p) => p.alive).length} votes in
                </div>
                <div className="votes">
                  {others.map((p) => (
                    <button key={p.id} className={view.myVote === p.id ? 'danger' : ''} onClick={() => emit('vote', { targetId: p.id })}>
                      {p.name}
                    </button>
                  ))}
                </div>
              </>
            ) : (
              <div className="muted">Voting in progress…</div>
            )}
          </div>
        )}
        {error && <div className="error small pad">{error}</div>}
      </main>

      <aside className="whispers glass">
        <h4>🤫 Whispers</h4>
        {view.whispers.length === 0 && <div className="muted small">Anonymous messages to you show up here. Some come with money.</div>}
        {[...view.whispers].reverse().map((w) => (
          <Whisper key={w.id} w={w} kiteMode={view.kiteMode} unit={view.unit} />
        ))}
        {view.phase === 'chat' && view.me.alive && <SendWhisper view={view} />}
      </aside>
    </div>
  );
}

/** Big animated title card whenever a round or the vote starts. */
function PhaseBanner({ view }: { view: RoomView }) {
  const [show, setShow] = useState(true);
  useEffect(() => {
    const t = setTimeout(() => setShow(false), 2600);
    return () => clearTimeout(t);
  }, []);
  if (!show) return null;
  const last = view.history[view.history.length - 1];
  return (
    <div className={`phasebanner ${view.phase}`}>
      {view.phase === 'chat' && view.round === 1 && (
        <div className="pb-out alias">
          Your secret codename is <b>{view.me.name}</b>. Don't tell anyone.
        </div>
      )}
      {view.phase === 'chat' && last && (
        <div className="pb-out">{last.eliminatedName ? `${last.eliminatedName} was human. The bot is still at the table.` : 'Tie. Nobody was voted out.'}</div>
      )}
      <div className="pb-kicker">{view.phase === 'vote' ? `Round ${view.round}` : `Round ${view.round} of ${view.maxRounds}`}</div>
      <div className="pb-title">{view.phase === 'vote' ? 'VOTE' : 'DISCUSS'}</div>
      <div className="pb-sub">{view.phase === 'vote' ? 'Who is the bot?' : view.topic}</div>
    </div>
  );
}

function Whisper({ w, kiteMode, unit }: { w: WhisperView; kiteMode: string; unit: string }) {
  const [err, setErr] = useState('');
  const act = async (action: 'accept' | 'decline' | 'expose') => {
    const r = await emit('bribe:respond', { whisperId: w.id, action });
    setErr(r.ok ? '' : (r.error ?? ''));
  };
  const isBribe = w.amount !== undefined;
  return (
    <div className={`whisper ${isBribe ? 'bribe' : ''} ${w.status}`}>
      <div className="small muted">
        anonymous
        {isBribe && <b className="money"> · offers {fmt(w.amount!, unit)}</b>}
      </div>
      <div>“{w.text}”</div>
      {isBribe && w.voteForName && (
        <div className="deal">
          The deal: vote <b>{w.voteForName}</b>
        </div>
      )}
      {isBribe && w.status === 'pending' && (
        <div className="row tight">
          <button className="gold" onClick={() => act('accept')}>
            Take {fmt(w.amount!, unit)}
          </button>
          <button onClick={() => act('decline')}>Decline</button>
          <button onClick={() => act('expose')}>Expose</button>
        </div>
      )}
      {isBribe && w.status !== 'pending' && (
        <div className="small">
          {w.status === 'paying' && <span className="waiting">Paying via Kite</span>}
          {w.status === 'accepted' && (
            <span className="ok">
              ✓ {fmt(w.amount!, unit)} paid{kiteMode === 'mock' ? ' (mock)' : ''}{' '}
              {w.txUrl ? (
                <a href={w.txUrl} target="_blank" rel="noreferrer">
                  view tx
                </a>
              ) : (
                <code>{w.txId?.slice(0, 16)}</code>
              )}
            </span>
          )}
          {w.status === 'failed' && <span className="error">Payment failed: {w.error}</span>}
          {['declined', 'exposed', 'expired'].includes(w.status) && <span className="muted">{w.status}</span>}
        </div>
      )}
      {err && <div className="error small">{err}</div>}
    </div>
  );
}

function SendWhisper({ view }: { view: RoomView }) {
  const targets = view.players.filter((p) => p.id !== view.me.id && p.alive);
  const [to, setTo] = useState(targets[0]?.id ?? '');
  const [text, setText] = useState('');
  const [msg, setMsg] = useState('');
  return (
    <form
      className="sendwhisper"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!text.trim()) return;
        const r = await emit('whisper', { toId: targets.some((t) => t.id === to) ? to : targets[0]?.id, text });
        setMsg(r.ok ? 'sent anonymously' : (r.error ?? ''));
        if (r.ok) setText('');
      }}
    >
      <div className="small muted">Send an anonymous whisper</div>
      <select value={to} onChange={(e) => setTo(e.target.value)}>
        {targets.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
      <input value={text} maxLength={200} onChange={(e) => setText(e.target.value)} placeholder="psst…" />
      <button>Whisper</button>
      {msg && <div className="small muted">{msg}</div>}
    </form>
  );
}
