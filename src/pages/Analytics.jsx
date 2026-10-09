import { useEffect, useMemo, useState } from 'react'
import {
  Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis
} from 'recharts'
import { C, dot } from '../lib/chartColors.js'
import { supabase } from '../lib/supabase.js'
import { resultValue } from '../lib/srs.js'
import { dayKey, fmtMin, streak, weekStart } from '../lib/stats.js'
import MathAnalytics from './MathAnalytics.jsx'

const DAY = 864e5
const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null)
const pct = (v) => (v === null || v === undefined ? '-' : `${Math.round(v * 100)}%`)

export default function Analytics({ userId }) {
  const [data, setData] = useState(null)

  useEffect(() => {
    setData(null)
    const since = new Date(Date.now() - 90 * DAY).toISOString()
    Promise.all([
      supabase.from('sessions').select('*').eq('user_id', userId).gte('started_at', since).order('started_at'),
      supabase.from('answers').select('card_id,deck_id,result,method,self_rating,created_at').eq('user_id', userId).gte('created_at', since).limit(10000),
      supabase.from('decks').select('id,title').eq('owner_id', userId),
      supabase.from('cards').select('id,deck_id,front,status,kind,concept_card_id').eq('owner_id', userId).eq('status', 'active'),
      supabase.from('card_stats').select('card_id,box,last_seen').eq('user_id', userId)
    ]).then(([s, a, d, c, st]) => setData({
      sessions: s.data || [], answers: a.data || [], decks: d.data || [], cards: c.data || [], stats: st.data || []
    }))
  }, [userId])

  const m = useMemo(() => (data ? compute(data) : null), [data])
  if (!m) return <p className="muted">Loading analytics...</p>
  if (!data.sessions.length) return <p className="muted">No study sessions yet.</p>

  const delta = m.acc14 !== null && m.accPrev14 !== null ? Math.round((m.acc14 - m.accPrev14) * 100) : null

  return (
    <>
      <div className="tiles">
        <div className="tile"><b>{fmtMin(m.sec7)}</b><span>studied, last 7 days</span></div>
        <div className="tile"><b>{fmtMin(m.sec30)}</b><span>last 30 days</span></div>
        <div className="tile"><b>{pct(m.acc14)}</b><span>accuracy, last 14 days</span></div>
        <div className="tile">
          <b className={delta > 0 ? 'good-text' : delta < 0 ? 'bad-text' : ''}>{delta === null ? '-' : `${delta > 0 ? '+' : ''}${delta} pts`}</b>
          <span>vs the 14 days before</span>
        </div>
        <div className="tile"><b>{pct(m.mastery)}</b><span>cards mastered</span></div>
        <div className="tile"><b>{m.streak}</b><span>day streak</span></div>
        <div className="tile"><b>{pct(m.claimRate)}</b><span>flip claims that passed the quick check</span></div>
        <div className="tile"><b>{m.overrides}</b><span>typed "I was right" overrides, 30 days</span></div>
        {m.accApp !== null && (
          <>
            <div className="tile"><b>{pct(m.accTerm)}</b><span>definition questions</span></div>
            <div className="tile"><b className={m.accTerm !== null && m.accApp < m.accTerm - 0.1 ? 'bad-text' : ''}>{pct(m.accApp)}</b><span>application questions</span></div>
          </>
        )}
      </div>

      <section className="card">
        <h3>Study minutes per day (last 14 days)</h3>
        <Chart><BarChart data={m.daily}><CartesianGrid vertical={false} /><XAxis dataKey="label" fontSize={11} /><YAxis fontSize={11} /><Tooltip /><Bar dataKey="minutes" fill={C.time} maxBarSize={28} radius={[4, 4, 0, 0]} /></BarChart></Chart>
      </section>

      <section className="card">
        <h3>Weekly accuracy (are they improving?)</h3>
        <Chart><LineChart data={m.weekly}><CartesianGrid vertical={false} /><XAxis dataKey="label" fontSize={11} /><YAxis domain={[0, 100]} fontSize={11} unit="%" /><Tooltip /><Line type="monotone" dataKey="accuracy" stroke={C.accuracy} strokeWidth={2} dot={dot(C.accuracy)} connectNulls /></LineChart></Chart>
      </section>

      <section className="card">
        <h3>Weekly study minutes</h3>
        <Chart><BarChart data={m.weekly}><CartesianGrid vertical={false} /><XAxis dataKey="label" fontSize={11} /><YAxis fontSize={11} /><Tooltip /><Bar dataKey="minutes" fill={C.time} maxBarSize={28} radius={[4, 4, 0, 0]} /></BarChart></Chart>
      </section>

      {m.tests.length > 0 && (
        <section className="card">
          <h3>Test scores over time</h3>
          <Chart><LineChart data={m.tests}><CartesianGrid vertical={false} /><XAxis dataKey="label" fontSize={11} /><YAxis domain={[0, 100]} fontSize={11} unit="%" /><Tooltip /><Line type="monotone" dataKey="score" stroke={C.test} strokeWidth={2} dot={dot(C.test)} /></LineChart></Chart>
        </section>
      )}

      <section className="card">
        <h3>By deck</h3>
        <table>
          <thead><tr><th>Deck</th><th>Cards</th><th>Mastered</th><th>Accuracy</th><th>Time</th><th>Last studied</th></tr></thead>
          <tbody>
            {m.byDeck.map((d) => (
              <tr key={d.id}><td>{d.title}</td><td>{d.cards}</td><td>{pct(d.mastered)}</td><td>{pct(d.acc)}</td><td>{fmtMin(d.sec)}</td><td>{d.last ? dayKey(d.last) : '-'}</td></tr>
            ))}
          </tbody>
        </table>
      </section>

      {m.weak.length > 0 && (
        <section className="card">
          <h3>Concepts giving them the most trouble (definitions and application questions combined)</h3>
          <table>
            <thead><tr><th>Concept</th><th>Missed</th><th>Tries</th></tr></thead>
            <tbody>{m.weak.map((w) => <tr key={w.id}><td>{w.front}</td><td>{w.wrong}</td><td>{w.tries}</td></tr>)}</tbody>
          </table>
        </section>
      )}
      <MathAnalytics userId={userId} />
    </>
  )
}

function Chart({ children }) {
  return <div style={{ width: '100%', height: 220 }}><ResponsiveContainer>{children}</ResponsiveContainer></div>
}

function compute({ sessions, answers, decks, cards, stats }) {
  const now = Date.now()
  const secSince = (days) => sessions.filter((s) => now - new Date(s.started_at) < days * DAY).reduce((a, s) => a + s.active_seconds, 0)
  const accIn = (from, to) => avg(answers.filter((a) => { const t = now - new Date(a.created_at); return t >= from * DAY && t < to * DAY }).map((a) => resultValue(a.result)))

  const daily = Array.from({ length: 14 }, (_, i) => {
    const d = new Date(now - (13 - i) * DAY)
    const k = dayKey(d)
    const sec = sessions.filter((s) => dayKey(s.started_at) === k).reduce((a, s) => a + s.active_seconds, 0)
    return { label: `${d.getMonth() + 1}/${d.getDate()}`, minutes: Math.round(sec / 60) }
  })

  const thisWeek = weekStart(new Date()).getTime()
  const weekly = Array.from({ length: 8 }, (_, i) => {
    const start = thisWeek - (7 - i) * 7 * DAY
    const end = start + 7 * DAY
    const inWk = (t) => { const x = new Date(t).getTime(); return x >= start && x < end }
    const sec = sessions.filter((s) => inWk(s.started_at)).reduce((a, s) => a + s.active_seconds, 0)
    const acc = avg(answers.filter((a) => inWk(a.created_at)).map((a) => resultValue(a.result)))
    const d = new Date(start)
    return { label: `${d.getMonth() + 1}/${d.getDate()}`, minutes: Math.round(sec / 60), accuracy: acc === null ? null : Math.round(acc * 100) }
  })

  const tests = sessions.filter((s) => s.mode === 'test' && s.completed && s.score_pct !== null)
    .map((s) => ({ label: dayKey(s.started_at).slice(5), score: Number(s.score_pct) }))

  const statById = Object.fromEntries(stats.map((s) => [s.card_id, s]))
  const mastered = (cs) => (cs.length ? cs.filter((c) => (statById[c.id]?.box || 0) >= 4).length / cs.length : null)

  const byDeck = decks.map((d) => {
    const cs = cards.filter((c) => c.deck_id === d.id)
    const ss = sessions.filter((s) => s.deck_id === d.id)
    return {
      id: d.id, title: d.title, cards: cs.length, mastered: mastered(cs),
      acc: avg(answers.filter((a) => a.deck_id === d.id).map((a) => resultValue(a.result))),
      sec: ss.reduce((a, s) => a + s.active_seconds, 0),
      last: ss.length ? ss[ss.length - 1].started_at : null
    }
  })

  const cardById = Object.fromEntries(cards.map((c) => [c.id, c]))
  const label = {}
  cards.forEach((c) => { label[c.concept_card_id || c.id] = c.kind === 'scenario' ? c.back : c.front })
  const tally = {}
  answers.forEach((a) => {
    const c = cardById[a.card_id]
    if (!c) return
    const k = c.concept_card_id || c.id
    const t = (tally[k] ||= { wrong: 0, tries: 0 })
    t.tries += 1
    if (a.result === 'wrong') t.wrong += 1
  })
  const weak = Object.entries(tally)
    .filter(([id, t]) => label[id] && t.wrong >= 2 && t.tries >= 3)
    .map(([id, t]) => ({ id, front: label[id], ...t }))
    .sort((a, b) => b.wrong / b.tries - a.wrong / a.tries || b.wrong - a.wrong)
    .slice(0, 8)
  const accOfKind = (kind) => avg(answers.filter((a) => cardById[a.card_id] && (cardById[a.card_id].kind || 'term') === kind).map((a) => resultValue(a.result)))

  return {
    sec7: secSince(7), sec30: secSince(30),
    acc14: accIn(0, 14), accPrev14: accIn(14, 28),
    mastery: mastered(cards), streak: streak(sessions),
    claimRate: (() => {
      const claims = answers.filter((a) => a.method === 'verified' && a.self_rating)
      return claims.length ? claims.filter((a) => a.result === 'correct').length / claims.length : null
    })(),
    overrides: answers.filter((a) => a.method === 'override' && now - new Date(a.created_at) < 30 * DAY).length,
    accTerm: accOfKind('term'), accApp: accOfKind('scenario'),
    daily, weekly, tests, byDeck, weak
  }
}
