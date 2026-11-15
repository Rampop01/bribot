import { useEffect, useState } from 'react';
import type { Stats } from '../../shared/types';
import { fmt } from './socket';

const pct = (n: number | null) => (n === null ? '–' : `${Math.round(n * 100)}%`);

export default function StatsPage() {
  const [s, setS] = useState<Stats | null>(null);
  useEffect(() => {
    const load = () => fetch('/api/stats').then((r) => r.json()).then(setS).catch(() => {});
    load();
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, []);
  if (!s) return <div className="center muted">Loading…</div>;

  // Rolling survival rate (last 5 games) per game, to show the bot getting better.
  const rolling = s.games.map((_, i) => {
    const w = s.games.slice(Math.max(0, i - 4), i + 1);
    return w.filter((g) => g.winner === 'bot').length / w.length;
  });

  return (
    <div className="stats">
      <a href="#" onClick={() => (location.hash = '')}>
        ← back to game
      </a>
      <h1>Bot learning stats</h1>
      <div className="kpis">
        <Kpi label="Games played" value={String(s.games.length)} />
        <Kpi label="Bot survival rate" value={pct(s.survivalRate)} />
        <Kpi label="Avg human-ness (players)" value={s.avgRating === null ? '–' : `${s.avgRating.toFixed(1)}/5`} />
        <Kpi label="Avg Reppo score" value={s.avgReppo === null ? '–' : `${Math.round(s.avgReppo)}/100`} />
        <Kpi label="Agent spend (Kite)" value={s.unit === '$' ? `$${s.totalSpent.toFixed(2)}` : `${s.totalSpent.toFixed(2)} ${s.unit}`} />
      </div>

      <section className="card glass enter">
        <h3>Survival rate over time (rolling 5 games)</h3>
        <LineChart values={rolling} />
      </section>

      <div className="grid2">
        <section className="card glass enter">
          <h3>What the bot has learned</h3>
          {s.lessons.length === 0 && <p className="muted small">No lessons yet. Finish a game and rate the bot.</p>}
          <ul className="lessons">
            {[...s.lessons].reverse().map((l, i) => (
              <li key={i}>
                <span className="pill">{l.source === 'reppo' ? 'Reppo' : 'self-reflection'}</span> {l.text}
              </li>
            ))}
          </ul>
        </section>
        <section className="card glass enter">
          <h3>Stack</h3>
          <ul className="small">
            <li>Brain: {s.integrations.serv}</li>
            <li>Payments: {s.integrations.kite}</li>
            <li>Evaluation: {s.integrations.reppo}</li>
          </ul>
        </section>
      </div>

      <section className="card glass enter">
        <h3>🏆 Bot hunters</h3>
        {s.leaderboard.length === 0 && <p className="muted small">Nobody has finished a game yet.</p>}
        {s.leaderboard.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Player</th>
                <th>Games</th>
                <th>Caught the bot</th>
                <th>Fooled by it</th>
                <th>Bribes taken</th>
                <th>Earned</th>
              </tr>
            </thead>
            <tbody>
              {s.leaderboard.map((p, i) => (
                <tr key={p.name}>
                  <td>{i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : i + 1}</td>
                  <td>{p.name}</td>
                  <td>{p.games}</td>
                  <td>{p.caught}</td>
                  <td>{p.fooled}</td>
                  <td>{p.bribesTaken}</td>
                  <td className="money">{fmt(p.earned, s.unit)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="card glass enter">
        <h3>Games</h3>
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>When</th>
              <th>Bot</th>
              <th>Winner</th>
              <th>Bribes (taken/offered)</th>
              <th>Rating</th>
              <th>Reppo</th>
            </tr>
          </thead>
          <tbody>
            {[...s.games].reverse().map((g, i) => (
              <tr key={g.id}>
                <td>{s.games.length - i}</td>
                <td>{new Date(g.endedAt).toLocaleString()}</td>
                <td>{g.botName}</td>
                <td>{g.winner === 'bot' ? '🤖 bot' : '🧑 humans'}</td>
                <td>
                  {g.bribesAccepted}/{g.bribesOffered} ({fmt(g.bribeSpend, s.unit)})
                </td>
                <td>{g.avgRating === null ? '–' : g.avgRating.toFixed(1)}</td>
                <td>{g.reppoScore ?? g.reppoStatus?.toLowerCase() ?? '–'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}

function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <div className="kpi glass">
      <div className="v">{value}</div>
      <div className="small muted">{label}</div>
    </div>
  );
}

function LineChart({ values }: { values: number[] }) {
  if (values.length < 2) return <p className="muted small">Play at least 2 games to see the trend.</p>;
  const W = 640;
  const H = 180;
  const P = 28;
  const x = (i: number) => P + (i * (W - 2 * P)) / (values.length - 1);
  const y = (v: number) => H - P - v * (H - 2 * P);
  const d = values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="chart" role="img" aria-label="Bot survival rate trend">
      {[0, 0.5, 1].map((g) => (
        <g key={g}>
          <line x1={P} x2={W - P} y1={y(g)} y2={y(g)} className="grid" />
          <text x={4} y={y(g) + 4} className="axis">
            {g * 100}%
          </text>
        </g>
      ))}
      <path d={d} className="line" />
      {values.map((v, i) => (
        <circle key={i} cx={x(i)} cy={y(v)} r={3.5} className="dot">
          <title>{`game ${i + 1}: ${Math.round(v * 100)}%`}</title>
        </circle>
      ))}
    </svg>
  );
}
