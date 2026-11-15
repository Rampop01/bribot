// The big personal result moment when the game ends: confetti if the bot was caught,
// a red glitch takeover if it fooled the table.
import { useEffect, useMemo, useState } from 'react';
import type { RoomView } from '../../shared/types';
import { fmt } from './socket';

export type MyOutcome = { kind: 'won' | 'caught' | 'played'; amount: number };

/** What the game's ending means for this particular player. */
export function myOutcome(view: RoomView): MyOutcome {
  const r = view.reveal!;
  if (r.winner === 'bot') return { kind: 'played', amount: 0 };
  const mine = r.payouts.find((p) => p.name === view.me.name);
  return mine ? { kind: 'won', amount: mine.amount } : { kind: 'caught', amount: 0 };
}

const COLORS = ['#7cf7c5', '#b28cff', '#ffc94d', '#5cc8ff', '#ff7eb6', '#ffffff'];

export default function Outcome({ view }: { view: RoomView }) {
  const [show, setShow] = useState(true);
  const o = myOutcome(view);
  const r = view.reveal!;
  useEffect(() => {
    const t = setTimeout(() => setShow(false), 3800);
    return () => clearTimeout(t);
  }, []);
  const confetti = useMemo(
    () =>
      Array.from({ length: 70 }, (_, i) => ({
        left: Math.random() * 100,
        delay: Math.random() * 0.9,
        dur: 1.8 + Math.random() * 1.6,
        color: COLORS[i % COLORS.length],
        rot: Math.random() * 360,
      })),
    [],
  );
  if (!show) return null;

  const good = o.kind !== 'played';
  return (
    <div className={`outcome ${good ? 'good' : 'bad'}`} onClick={() => setShow(false)}>
      {good &&
        confetti.map((c, i) => (
          <i key={i} className="confetto" style={{ left: `${c.left}%`, background: c.color, animationDelay: `${c.delay}s`, animationDuration: `${c.dur}s`, transform: `rotate(${c.rot}deg)` }} />
        ))}
      {!good && <div className="scanlines" />}
      <div className="oc-kicker">{good ? 'Bot caught' : 'The bot survived'}</div>
      <div className="oc-title" data-text={o.kind === 'won' ? 'YOU GOT IT' : o.kind === 'caught' ? 'CAUGHT' : 'YOU GOT PLAYED'}>
        {o.kind === 'won' ? 'YOU GOT IT' : o.kind === 'caught' ? 'CAUGHT' : 'YOU GOT PLAYED'}
      </div>
      <div className="oc-sub">
        {o.kind === 'won' && (
          <>
            You voted for <b>{r.botName}</b> and earned <b className="money">+{fmt(o.amount, view.unit)}</b>
          </>
        )}
        {o.kind === 'caught' && (
          <>
            <b>{r.botName}</b> was the bot, but you voted for someone else. No bounty for you.
          </>
        )}
        {o.kind === 'played' && (
          <>
            <b>{r.botName}</b> was the bot all along and keeps its {fmt(r.bounty, view.unit)} bounty.
          </>
        )}
      </div>
    </div>
  );
}
