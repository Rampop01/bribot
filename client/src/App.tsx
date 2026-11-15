import { useEffect, useRef, useState } from 'react';
import type { RoomView } from '../../shared/types';
import Game from './Game';
import { myOutcome } from './Outcome';
import Reveal from './Reveal';
import Stage, { type StageMode } from './Scene3D';
import { clearSession, emit, fmt, loadSession, saveSession, socket } from './socket';
import { isMuted, setMuted, sfx } from './sfx';
import StatsPage from './Stats';

export default function App() {
  const [view, setView] = useState<RoomView | null>(null);
  const [hash, setHash] = useState(location.hash);
  const [coinKey, setCoinKey] = useState(0);
  const paid = useRef(0);

  useEffect(() => {
    const onHash = () => setHash(location.hash);
    const resume = () => {
      const s = loadSession();
      if (s) void emit('resume', s).then((r) => !r.ok && clearSession());
    };
    window.addEventListener('hashchange', onHash);
    socket.on('state', setView);
    socket.on('connect', resume);
    if (socket.connected) resume();
    return () => {
      window.removeEventListener('hashchange', onHash);
      socket.off('state', setView);
      socket.off('connect', resume);
    };
  }, []);

  // Coins erupt in 3D whenever money lands in my wallet (bribe accepted or bounty paid).
  useEffect(() => {
    if (!view) return void (paid.current = 0);
    const n =
      view.whispers.filter((w) => w.status === 'accepted').length +
      (view.reveal?.payouts.filter((p) => p.name === view.me.name && p.status === 'paid').length ?? 0);
    if (n > paid.current) setCoinKey((k) => k + 1);
    paid.current = n;
  }, [view]);

  // Sound effects, driven by what changed since the previous update.
  const prev = useRef<RoomView | null>(null);
  const [muted, setMutedState] = useState(isMuted());
  useEffect(() => {
    const p = prev.current;
    prev.current = view;
    if (!view || !p || p.code !== view.code) return;
    const lastMsg = view.messages[view.messages.length - 1];
    if (view.messages.length > p.messages.length && lastMsg?.kind === 'chat' && lastMsg.playerId !== view.me.id) sfx.pop();
    const pending = (v: RoomView) => v.whispers.filter((w) => w.status === 'pending' && w.amount).length;
    if (pending(view) > pending(p)) sfx.whisper();
    const accepted = (v: RoomView) => v.whispers.filter((w) => w.status === 'accepted').length;
    if (accepted(view) > accepted(p)) sfx.coin();
    if (view.phase !== p.phase) {
      if (view.phase === 'vote') sfx.vote();
      else if (view.phase === 'chat') view.history.length > p.history.length ? sfx.out() : sfx.round();
      else if (view.phase === 'reveal') myOutcome(view).kind === 'played' ? sfx.lose() : sfx.win();
    } else if (view.round !== p.round) sfx.out();
  }, [view]);

  const leave = () => {
    clearSession();
    void emit('leave');
    setView(null);
  };

  const stats = hash === '#stats';
  const mode: StageMode = stats ? 'stats' : !view ? 'home' : view.phase === 'lobby' ? 'lobby' : view.phase === 'reveal' ? 'reveal' : 'game';

  return (
    <>
      <Stage view={stats ? null : view} mode={mode} coinKey={coinKey} onVote={(id) => void emit('vote', { targetId: id })} />
      <button
        className="mute"
        title={muted ? 'Sound off' : 'Sound on'}
        onClick={() => {
          setMuted(!muted);
          setMutedState(!muted);
        }}
      >
        {muted ? '🔇' : '🔊'}
      </button>
      <div className="ui">
        {stats ? (
          <StatsPage />
        ) : !view ? (
          <Home />
        ) : view.phase === 'lobby' ? (
          <Lobby view={view} onLeave={leave} />
        ) : view.phase === 'reveal' ? (
          <Reveal view={view} onLeave={leave} />
        ) : (
          <Game view={view} />
        )}
      </div>
    </>
  );
}

function Home() {
  const params = new URLSearchParams(location.search);
  const [name, setName] = useState(localStorage.getItem('wtb.name') ?? '');
  const [wallet, setWallet] = useState(localStorage.getItem('wtb.wallet') ?? '');
  const [code, setCode] = useState(params.get('room') ?? '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const go = async (event: 'create' | 'join') => {
    setBusy(true);
    setError('');
    localStorage.setItem('wtb.name', name);
    localStorage.setItem('wtb.wallet', wallet);
    const r = await emit(event, { name, wallet, code });
    setBusy(false);
    if (!r.ok) return setError(r.error ?? 'Something went wrong');
    if (r.session) saveSession(r.session);
  };

  return (
    <div className="split">
      <div className="pitch">
        <div className="kicker">Who's the bot? A social-deduction game with real stakes</div>
        <h1 className="title">
          <span className="glitch" data-text="Bribot">Bribot</span>
        </h1>
        <p className="tag">One player in this chat is an AI. It has a wallet. It will try to bribe you.</p>
        <div className="chips">
          <span>🧠 SERV Reasoning</span>
          <span>💸 Kite payments</span>
          <span>📊 Reppo verdicts</span>
        </div>
      </div>

      <div className="card glass enter">
        <label>Your name</label>
        <input value={name} maxLength={20} onChange={(e) => setName(e.target.value)} placeholder="e.g. Ada" />
        <label>
          Wallet <span className="muted">(optional, to receive bribes &amp; bounty)</span>
        </label>
        <input value={wallet} onChange={(e) => setWallet(e.target.value.trim())} placeholder="0x…" spellCheck={false} />

        <button className="primary big" disabled={busy || !name.trim()} onClick={() => go('create')}>
          Create room
        </button>
        <div className="or">or join a friend</div>
        <div className="row">
          <input className="code" value={code} maxLength={4} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="CODE" />
          <button disabled={busy || !name.trim() || code.length !== 4} onClick={() => go('join')}>
            Join
          </button>
        </div>
        {error && <p className="error">{error}</p>}

        <details className="how">
          <summary>How to play</summary>
          <ol>
            <li>Chat about the round's topic. One of you is secretly an AI agent.</li>
            <li>The bot may whisper you an anonymous bribe, paid instantly from its Kite wallet. Take it, decline it, or expose it.</li>
            <li>Vote out who you think is the bot. Catch it and you split its bounty. Miss and it lives.</li>
            <li>At the end, the bot's hidden reasoning is revealed, and you can verify the game was fair.</li>
          </ol>
        </details>
        <a className="muted small" href="#stats">
          Bot learning stats →
        </a>
      </div>
    </div>
  );
}

function Lobby({ view, onLeave }: { view: RoomView; onLeave: () => void }) {
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const link = `${location.origin}/?room=${view.code}`;
  const enough = view.players.length >= view.minPlayers;
  return (
    <div className="split">
      <div className="pitch">
        <div className="kicker">Room code</div>
        <div className="bigcode">
          {view.code.split('').map((c, i) => (
            <span key={i} style={{ animationDelay: `${i * 80}ms` }}>
              {c}
            </span>
          ))}
        </div>
        <p className="tag">When the game starts, everyone gets a secret codename and an AI slips in among you. Nobody will know who is who.</p>
      </div>
      <div className="card glass enter">
        <h3>Players at the table ({view.players.length})</h3>
        <ul className="players">
          {view.players.map((p) => (
            <li key={p.id} className="pop">
              {p.name}
              {p.isHost && <span className="pill">host</span>}
              {p.id === view.me.id && <span className="pill">you</span>}
            </li>
          ))}
        </ul>
        <p className="muted small">
          Bounty: <b className="money">{fmt(view.bounty, view.unit)}</b>, split by whoever catches the bot.
          {!view.me.hasWallet && view.kiteMode !== 'mock' && ' Add a wallet on the home screen to get paid.'}
        </p>
        <button
          onClick={() => {
            void navigator.clipboard?.writeText(link);
            setCopied(true);
          }}
        >
          {copied ? 'Invite link copied ✓' : 'Copy invite link'}
        </button>
        {view.me.isHost ? (
          <button
            className="primary big"
            disabled={!enough}
            onClick={async () => {
              const r = await emit('start');
              if (!r.ok) setError(r.error ?? 'Could not start');
            }}
          >
            {enough ? 'Start game' : 'Waiting for players…'}
          </button>
        ) : (
          <p className="muted waiting">Waiting for the host to start</p>
        )}
        {error && <p className="error">{error}</p>}
        <button className="link" onClick={onLeave}>
          Leave
        </button>
      </div>
    </div>
  );
}
