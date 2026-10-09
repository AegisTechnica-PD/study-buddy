import { useEffect, useMemo, useState } from 'react'
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { C, dot } from '../lib/chartColors.js'
import { supabase } from '../lib/supabase.js'
import { OPS, OP_LIST, factAt, keyOf, textOf, thresholdMs, universeSize } from '../lib/mathfacts.js'
import { weekStart } from '../lib/stats.js'

const DAY = 864e5
const median = (xs) => {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}

export default function MathAnalytics({ userId }) {
  const [data, setData] = useState(null)
  const [gridOp, setGridOp] = useState('mul')

  useEffect(() => {
    setData(null)
    const since = new Date(Date.now() - 90 * DAY).toISOString()
    Promise.all([
      supabase.from('math_attempts').select('op,a,b,correct,response_ms,is_retry,created_at').eq('user_id', userId).gte('created_at', since).limit(10000),
      supabase.from('math_fact_stats').select('*').eq('user_id', userId).limit(2000)
    ]).then(([a, s]) => setData({ attempts: a.data || [], stats: s.data || [] }))
  }, [userId])

  const m = useMemo(() => (data ? compute(data) : null), [data])
  if (!m || !data.attempts.length) return null

  return (
    <>
      <h2>Math facts</h2>
      <section className="card">
        <h3>By operation (last 30 days, first tries only)</h3>
        <table>
          <thead><tr><th>Operation</th><th>Accuracy</th><th>Typical speed</th><th>Goal</th><th>Fluent facts (0 to 12)</th></tr></thead>
          <tbody>
            {m.byOp.map((o) => (
              <tr key={o.op}>
                <td>{OPS[o.op].sym} {OPS[o.op].label}</td>
                <td>{o.acc === null ? '-' : `${Math.round(o.acc * 100)}%`}</td>
                <td className={o.ms !== null && o.ms > thresholdMs(o.op) ? 'bad-text' : ''}>{o.ms === null ? '-' : `${(o.ms / 1000).toFixed(1)}s`}</td>
                <td>{thresholdMs(o.op) / 1000}s</td>
                <td>{o.fluent} of {o.total}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="card">
        <h3>Weekly accuracy</h3>
        <div style={{ width: '100%', height: 200 }}>
          <ResponsiveContainer>
            <LineChart data={m.weekly}><CartesianGrid vertical={false} /><XAxis dataKey="label" fontSize={11} /><YAxis domain={[0, 100]} fontSize={11} unit="%" /><Tooltip /><Line type="monotone" dataKey="accuracy" stroke={C.accuracy} strokeWidth={2} dot={dot(C.accuracy)} connectNulls /></LineChart>
          </ResponsiveContainer>
        </div>
      </section>

      <section className="card">
        <h3>Weekly speed (seconds per correct answer, lower is better)</h3>
        <div style={{ width: '100%', height: 200 }}>
          <ResponsiveContainer>
            <LineChart data={m.weekly}><CartesianGrid vertical={false} /><XAxis dataKey="label" fontSize={11} /><YAxis fontSize={11} unit="s" /><Tooltip /><Line type="monotone" dataKey="seconds" stroke={C.speed} strokeWidth={2} dot={dot(C.speed)} connectNulls /></LineChart>
          </ResponsiveContainer>
        </div>
      </section>

      <section className="card">
        <h3>Fact map</h3>
        <div className="chips">
          {OP_LIST.map((op) => (
            <button key={op} className={`chip ${gridOp === op ? 'on' : ''}`} onClick={() => setGridOp(op)}>{OPS[op].sym} {OPS[op].label}</button>
          ))}
        </div>
        <FactGrid op={gridOp} stats={m.statMap} />
        <p className="muted legend">
          <span className="sw g-unseen" /> not seen yet <span className="sw g-weak" /> missed or new <span className="sw g-learn" /> learning <span className="sw g-fluent" /> fluent.
          {' '}{gridOp === 'sub' && 'Rows: amount taken away. Columns: the answer.'}
          {gridOp === 'div' && 'Rows: the answer. Columns: the divisor.'}
          {(gridOp === 'add' || gridOp === 'mul') && 'Rows and columns are the two numbers.'}
          {' '}Hover or tap a square for details.
        </p>
      </section>

      {m.trouble.length > 0 && (
        <section className="card">
          <h3>Facts giving them the most trouble</h3>
          <table>
            <thead><tr><th>Fact</th><th>Right</th><th>Wrong</th><th>Typical speed</th></tr></thead>
            <tbody>
              {m.trouble.map((t) => (
                <tr key={keyOf(t)}><td>{textOf(t)} = {t.answer}</td><td>{t.correct_count}</td><td>{t.wrong_count}</td><td>{t.avg_ms ? `${(t.avg_ms / 1000).toFixed(1)}s` : '-'}</td></tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </>
  )
}

function FactGrid({ op, stats }) {
  const idx = Array.from({ length: 13 }, (_, i) => i)
  const cols = op === 'div' ? idx.filter((j) => j >= 1) : idx
  return (
    <div className="gridwrap">
      <table className="fgrid">
        <thead>
          <tr><th />{cols.map((j) => <th key={j}>{j}</th>)}</tr>
        </thead>
        <tbody>
          {idx.map((i) => (
            <tr key={i}>
              <th>{i}</th>
              {cols.map((j) => {
                const f = factAt(op, i, j)
                const s = stats[keyOf(f)]
                const cls = !s ? 'g-unseen' : s.box >= 4 ? 'g-fluent' : s.box >= 2 ? 'g-learn' : 'g-weak'
                const tip = `${textOf(f)} = ${f.answer}` + (s ? `: ${s.correct_count} right, ${s.wrong_count} wrong${s.avg_ms ? `, about ${(s.avg_ms / 1000).toFixed(1)}s` : ''}` : ': not seen yet')
                return <td key={j} className={cls} title={tip} />
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function compute({ attempts, stats }) {
  const now = Date.now()
  const first = attempts.filter((a) => !a.is_retry)
  const statMap = Object.fromEntries(stats.map((s) => [`${s.op}|${s.a}|${s.b}`, s]))

  const byOp = OP_LIST.map((op) => {
    const mine = first.filter((a) => a.op === op && now - new Date(a.created_at) < 30 * DAY)
    const right = mine.filter((a) => a.correct)
    return {
      op,
      acc: mine.length ? right.length / mine.length : null,
      ms: median(right.map((a) => a.response_ms).filter(Boolean)),
      fluent: stats.filter((s) => s.op === op && s.box >= 4).length,
      total: universeSize(op, 12)
    }
  }).filter((o) => o.acc !== null || o.fluent > 0)

  const thisWeek = weekStart(new Date()).getTime()
  const weekly = Array.from({ length: 8 }, (_, i) => {
    const start = thisWeek - (7 - i) * 7 * DAY
    const end = start + 7 * DAY
    const inWk = first.filter((a) => { const t = new Date(a.created_at).getTime(); return t >= start && t < end })
    const right = inWk.filter((a) => a.correct)
    const ms = right.map((a) => a.response_ms).filter(Boolean)
    const d = new Date(start)
    return {
      label: `${d.getMonth() + 1}/${d.getDate()}`,
      accuracy: inWk.length ? Math.round((right.length / inWk.length) * 100) : null,
      seconds: ms.length ? Math.round((ms.reduce((a, b) => a + b, 0) / ms.length / 1000) * 10) / 10 : null
    }
  })

  const trouble = stats
    .filter((s) => s.correct_count + s.wrong_count >= 2 && (s.wrong_count > 0 || (s.avg_ms || 0) > thresholdMs(s.op) * 1.5))
    .map((s) => ({ ...factAt(s.op, 0, 0), ...s, ...rebuild(s) }))
    .sort((x, y) => (y.wrong_count / (y.correct_count + y.wrong_count)) - (x.wrong_count / (x.correct_count + x.wrong_count)) || (y.avg_ms || 0) - (x.avg_ms || 0))
    .slice(0, 10)

  return { byOp, weekly, trouble, statMap }
}

// Stats rows store a and b exactly as asked, so the answer is derived from them.
function rebuild(s) {
  const answer = s.op === 'add' ? s.a + s.b : s.op === 'sub' ? s.a - s.b : s.op === 'mul' ? s.a * s.b : s.a / s.b
  return { op: s.op, a: s.a, b: s.b, answer }
}
