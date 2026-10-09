import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase.js'
import { useAuth } from '../auth.jsx'
import { useActiveTimer } from '../lib/useActiveTimer.js'
import { OPS, OP_LIST, allFacts, keyOf, nextMathStat, pickNext, textOf, thresholdMs } from '../lib/mathfacts.js'
import { fmtMin } from '../lib/stats.js'

const TIMED_SECONDS = 60
const clock = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`

export default function MathFacts() {
  const { profile } = useAuth()
  const nav = useNavigate()
  const [cfg, setCfg] = useState({ ops: [...OP_LIST], max: 9, mode: 'practice', count: 20 })
  const [phase, setPhase] = useState('setup')
  const [stats, setStats] = useState({})
  const [q, setQ] = useState(null) // { fact, retry }
  const [input, setInput] = useState('')
  const [status, setStatus] = useState('ask') // ask | right | wrong
  const [qNum, setQNum] = useState(1)
  const [liveCorrect, setLiveCorrect] = useState(0)
  const [timeLeft, setTimeLeft] = useState(TIMED_SECONDS)
  const [summary, setSummary] = useState(null)

  const run = useRef(null)
  const sessionId = useRef(null)
  const shownAt = useRef(0)
  const timers = useRef([])
  const ticker = useRef(null)
  const statsRef = useRef({})
  const inputRef = useRef(null)
  const activeSec = useActiveTimer(phase === 'run', (s) => {
    if (sessionId.current) supabase.from('sessions').update({ active_seconds: s }).eq('id', sessionId.current).then(() => {})
  })

  useEffect(() => {
    supabase.from('math_fact_stats').select('*').eq('user_id', profile.id).limit(2000).then(({ data }) => {
      const m = {}
      ;(data || []).forEach((s) => { m[`${s.op}|${s.a}|${s.b}`] = s })
      statsRef.current = m
      setStats(m)
    })
    return () => {
      timers.current.forEach(clearTimeout)
      clearInterval(ticker.current)
    }
  }, [profile.id])

  useEffect(() => {
    if (phase === 'run') inputRef.current?.focus()
  }, [phase, q, status])

  const later = (fn, ms) => timers.current.push(setTimeout(fn, ms))
  const timed = cfg.mode === 'timed'

  async function start() {
    const pool = cfg.ops.flatMap((op) => allFacts(op, cfg.max))
    const { data } = await supabase.from('sessions').insert({ user_id: profile.id, mode: 'math' }).select().single()
    sessionId.current = data?.id
    run.current = { pool, recent: [], retries: [], shown: 0, first: 0, firstCorrect: 0, fast: 0, ms: [], missed: [], newCount: 0, ended: false }
    activeSec.current = 0
    statsRef.current = { ...stats }
    setLiveCorrect(0)
    setPhase('run')
    if (timed) {
      const deadline = Date.now() + TIMED_SECONDS * 1000
      setTimeLeft(TIMED_SECONDS)
      ticker.current = setInterval(() => {
        const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000))
        setTimeLeft(left)
        if (left <= 0) finish()
      }, 250)
    }
    nextQuestion()
  }

  function nextQuestion() {
    const r = run.current
    if (!r || r.ended) return
    const practiceDone = !timed && r.first >= cfg.count
    if (practiceDone && r.retries.length === 0) return finish()
    let item
    const ri = r.retries.findIndex((x) => x.at <= r.shown + 1)
    if (ri >= 0 || (practiceDone && r.retries.length)) {
      item = { fact: r.retries.splice(ri >= 0 ? ri : 0, 1)[0].fact, retry: true }
    } else {
      const fact = pickNext(r.pool, statsRef.current, { newLimit: 8, newCount: r.newCount, recent: r.recent })
      if (!statsRef.current[keyOf(fact)]) r.newCount += 1
      item = { fact, retry: false }
    }
    r.shown += 1
    r.recent = [...r.recent, keyOf(item.fact)].slice(-3)
    shownAt.current = Date.now()
    setQNum(r.first + 1)
    setQ(item)
    setInput('')
    setStatus('ask')
  }

  function submit(e) {
    e.preventDefault()
    const r = run.current
    if (!r || r.ended || !q) return
    const val = input.trim()

    if (status === 'wrong') {
      // Practice mode: type the right answer to move on.
      if (!timed && Number(val) === q.fact.answer && val !== '') nextQuestion()
      else setInput('')
      return
    }
    if (status !== 'ask' || val === '') return

    const ms = Math.min(Date.now() - shownAt.current, 30000)
    const correct = Number(val) === q.fact.answer
    const f = q.fact
    supabase.from('math_attempts').insert({
      session_id: sessionId.current, user_id: profile.id, op: f.op, a: f.a, b: f.b,
      given: val.slice(0, 12), correct, response_ms: ms, is_retry: q.retry
    }).then(() => {})
    const ns = { ...nextMathStat(statsRef.current[keyOf(f)], correct, ms, f.op), user_id: profile.id, op: f.op, a: f.a, b: f.b }
    statsRef.current[keyOf(f)] = ns
    supabase.from('math_fact_stats').upsert(ns).then(() => {})

    if (!q.retry) {
      r.first += 1
      if (correct) {
        r.firstCorrect += 1
        r.ms.push(ms)
        if (ms <= thresholdMs(f.op)) r.fast += 1
        setLiveCorrect(r.firstCorrect)
      } else {
        r.missed.push(f)
        r.retries.push({ fact: f, at: r.shown + 3 }) // ask it again about 3 questions later
      }
    }
    if (correct) {
      setStatus('right')
      later(nextQuestion, 450)
    } else {
      setStatus('wrong')
      if (timed) later(nextQuestion, 1400)
    }
  }

  async function finish() {
    const r = run.current
    if (!r || r.ended) return
    r.ended = true
    timers.current.forEach(clearTimeout)
    clearInterval(ticker.current)
    const seconds = activeSec.current
    const score = r.first ? Math.round((r.firstCorrect / r.first) * 1000) / 10 : 0
    const seen = new Set()
    const missed = r.missed.filter((f) => (seen.has(keyOf(f)) ? false : seen.add(keyOf(f))))
    setSummary({
      first: r.first, correct: r.firstCorrect, score, fast: r.fast, seconds, missed, newCount: r.newCount,
      avgMs: r.ms.length ? Math.round(r.ms.reduce((a, b) => a + b, 0) / r.ms.length) : null
    })
    setStats({ ...statsRef.current })
    setPhase('done')
    if (sessionId.current) {
      await supabase.from('sessions').update({
        ended_at: new Date().toISOString(), active_seconds: seconds, cards_answered: r.first,
        correct: r.firstCorrect, unsure: 0, score_pct: score, completed: true
      }).eq('id', sessionId.current)
    }
  }

  const toggleOp = (op) => {
    const has = cfg.ops.includes(op)
    setCfg({ ...cfg, ops: has ? cfg.ops.filter((o) => o !== op) : [...cfg.ops, op] })
  }

  // ---------- setup ----------
  if (phase === 'setup') {
    return (
      <>
        <p><Link to="/">&larr; Home</Link></p>
        <h2>Math facts</h2>
        <p className="muted">
          Short drills to get quick and accurate. A fact counts as learned only when you get it right fast
          (about 3 seconds for + and −, 4 for × and ÷) on several different days. Facts you miss come right back.
        </p>
        <section className="card">
          <h3>What to practice</h3>
          <div className="chips">
            {OP_LIST.map((op) => {
              const pool = allFacts(op, cfg.max)
              const fluent = pool.filter((f) => (stats[keyOf(f)]?.box || 0) >= 4).length
              return (
                <button key={op} className={`chip ${cfg.ops.includes(op) ? 'on' : ''}`} onClick={() => toggleOp(op)}>
                  {OPS[op].sym} {OPS[op].label}
                  <small>{fluent} of {pool.length} fluent</small>
                </button>
              )
            })}
          </div>
          <div className="row">
            <label>Numbers up to
              <select value={cfg.max} onChange={(e) => setCfg({ ...cfg, max: Number(e.target.value) })}>
                <option value={5}>5</option>
                <option value={9}>9</option>
                <option value={12}>12</option>
              </select>
            </label>
            <label>Type of round
              <select value={cfg.mode} onChange={(e) => setCfg({ ...cfg, mode: e.target.value })}>
                <option value="practice">Practice (see the answer when you miss)</option>
                <option value="timed">60 second speed round</option>
              </select>
            </label>
            {cfg.mode === 'practice' && (
              <label>Questions
                <select value={cfg.count} onChange={(e) => setCfg({ ...cfg, count: Number(e.target.value) })}>
                  <option value={10}>10</option>
                  <option value={20}>20</option>
                  <option value={30}>30</option>
                  <option value={50}>50</option>
                </select>
              </label>
            )}
            <button className="primary big" disabled={!cfg.ops.length} onClick={start}>Start</button>
          </div>
        </section>
      </>
    )
  }

  // ---------- done ----------
  if (phase === 'done') {
    return (
      <>
        <h2>{timed ? 'Speed round' : 'Round done'}</h2>
        <div className="card score">
          <div className="big-num">{timed ? summary.correct : `${summary.score}%`}</div>
          <p>
            {timed ? `${summary.correct} right in 60 seconds. ` : ''}
            {summary.correct} of {summary.first} right the first time
            {summary.avgMs ? `, about ${(summary.avgMs / 1000).toFixed(1)} seconds each` : ''}.
            {' '}{summary.fast} were fast enough to count toward learning. {fmtMin(summary.seconds)} of study time.
          </p>
          {summary.newCount > 0 && <p className="muted">{summary.newCount} new facts introduced.</p>}
        </div>
        {summary.missed.length > 0 && (
          <section className="card">
            <h3>Work on these</h3>
            <div className="chips">
              {summary.missed.map((f) => <span key={keyOf(f)} className="chip static">{textOf(f)} = {f.answer}</span>)}
            </div>
            <p className="muted">They will come back first next time.</p>
          </section>
        )}
        <div className="row">
          <button className="primary" onClick={() => { setSummary(null); setPhase('setup') }}>Go again</button>
          <button onClick={() => nav('/')}>Home</button>
        </div>
      </>
    )
  }

  // ---------- run ----------
  return (
    <>
      <div className="row between">
        <span className="muted">
          {timed ? `Time ${clock(timeLeft)}   Right: ${liveCorrect}` : `Question ${Math.min(qNum, cfg.count)} of ${cfg.count}`}
        </span>
        <button className="link" onClick={finish}>End round</button>
      </div>
      {q && (
        <form className={`card mathq ${status === 'right' ? 'ok' : status === 'wrong' ? 'no' : ''}`} onSubmit={submit}>
          {q.retry && <p className="badge">Try again: you missed this one</p>}
          <div className="eq">{textOf(q.fact)} =</div>
          {status === 'wrong' ? (
            <>
              <div className="eq bad-text">{q.fact.answer}</div>
              {!timed && <p className="muted">Type {q.fact.answer} to keep going</p>}
            </>
          ) : status === 'right' ? (
            <div className="eq good-text">{q.fact.answer}</div>
          ) : null}
          <input
            ref={inputRef}
            className="mathin"
            inputMode="numeric"
            pattern="[0-9]*"
            autoComplete="off"
            value={input}
            onChange={(e) => setInput(e.target.value.replace(/[^0-9]/g, ''))}
            disabled={status === 'right' || (status === 'wrong' && timed)}
          />
          <p><button className="primary big" disabled={!input.trim() || status === 'right'}>Enter</button></p>
        </form>
      )}
    </>
  )
}
