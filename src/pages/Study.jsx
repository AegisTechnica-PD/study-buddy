import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { supabase } from '../lib/supabase.js'
import { useAuth } from '../auth.jsx'
import { buildQueue, makeChoices, nextStat, resultValue, typedMatch } from '../lib/srs.js'
import { fmtMin } from '../lib/stats.js'

const MODES = [
  { id: 'flip', label: 'Flip cards', help: 'Flip, rate yourself, then a quick check proves it' },
  { id: 'mc', label: 'Multiple choice', help: 'Pick the right answer' },
  { id: 'type', label: 'Type it', help: 'Type the answer from memory' },
  { id: 'test', label: 'Test', help: 'Random cards, no hints, scored at the end' }
]

export default function Study() {
  const { id } = useParams()
  const nav = useNavigate()
  const { profile } = useAuth()
  const [deck, setDeck] = useState(null)
  const [cards, setCards] = useState([])
  const [stats, setStats] = useState({})
  const [cfg, setCfg] = useState({ mode: 'flip', count: 20, order: 'smart', kind: 'all' })
  const [phase, setPhase] = useState('setup')
  const [queue, setQueue] = useState([])
  const [idx, setIdx] = useState(0)
  const [results, setResults] = useState([])
  const [summary, setSummary] = useState(null)

  const sessionId = useRef(null)
  const startedAt = useRef(0)
  const activeSec = useRef(0)
  const lastAct = useRef(Date.now())
  const resultsRef = useRef([])

  useEffect(() => {
    Promise.all([
      supabase.from('decks').select('*').eq('id', id).single(),
      supabase.from('cards').select('*').eq('deck_id', id).eq('status', 'active'),
      supabase.from('card_stats').select('*').eq('user_id', profile.id)
    ]).then(([d, c, s]) => {
      setDeck(d.data)
      setCards(c.data || [])
      setStats(Object.fromEntries((s.data || []).map((x) => [x.card_id, x])))
    })
  }, [id, profile.id])

  // Study timer: counts only while the tab is visible and the student is interacting.
  useEffect(() => {
    if (phase !== 'run') return
    const touch = () => { lastAct.current = Date.now() }
    const evs = ['pointerdown', 'keydown', 'touchstart', 'scroll']
    evs.forEach((e) => window.addEventListener(e, touch, { passive: true }))
    let ticks = 0
    const t = setInterval(() => {
      if (document.visibilityState === 'visible' && Date.now() - lastAct.current < 60000) activeSec.current += 1
      ticks += 1
      if (ticks % 15 === 0 && sessionId.current) {
        supabase.from('sessions').update({ active_seconds: activeSec.current }).eq('id', sessionId.current).then(() => {})
      }
    }, 1000)
    return () => {
      clearInterval(t)
      evs.forEach((e) => window.removeEventListener(e, touch))
    }
  }, [phase])

  const poolOf = () => cards.filter((c) => cfg.kind === 'all' || (c.kind || 'term') === cfg.kind)

  const kindFor = (item) => {
    if (item.verify || cfg.mode === 'test') return makeChoices(item.card, cards) ? 'mc' : 'type'
    return cfg.mode
  }

  async function start() {
    const order = cfg.mode === 'test' ? 'random' : cfg.order
    const q = buildQueue(poolOf(), stats, { order, count: Number(cfg.count) })
    const { data } = await supabase
      .from('sessions')
      .insert({ user_id: profile.id, deck_id: id, mode: cfg.mode })
      .select()
      .single()
    sessionId.current = data?.id
    startedAt.current = Date.now()
    activeSec.current = 0
    lastAct.current = Date.now()
    resultsRef.current = []
    setQueue(q.map((card) => ({ card })))
    setIdx(0)
    setResults([])
    setPhase('run')
  }

  async function finish(all) {
    const correct = all.filter((r) => r.result === 'correct').length
    const unsure = all.filter((r) => r.result === 'unsure').length
    const score = all.length ? Math.round((all.reduce((a, r) => a + resultValue(r.result), 0) / all.length) * 1000) / 10 : 0
    await supabase.from('sessions').update({
      ended_at: new Date().toISOString(),
      active_seconds: activeSec.current,
      cards_answered: all.length,
      correct,
      unsure,
      score_pct: score,
      completed: true
    }).eq('id', sessionId.current)
    setSummary({ correct, unsure, wrong: all.length - correct - unsure, score, seconds: activeSec.current })
    setPhase('done')
  }

  // item = { card, verify?, selfRating? }. method: 'auto' | 'self' | 'override' (verified is set from item.verify)
  function answer(item, result, ms, method = 'auto') {
    const card = item.card
    const all = [...resultsRef.current, { card, result }]
    resultsRef.current = all
    setResults(all)
    supabase.from('answers').insert({
      session_id: sessionId.current, user_id: profile.id, deck_id: id, card_id: card.id, result, response_ms: ms,
      method: item.verify ? 'verified' : method,
      self_rating: item.selfRating || (method === 'self' ? 'wrong' : null)
    }).then(() => {})
    const ns = { ...nextStat(stats[card.id], result), user_id: profile.id, card_id: card.id }
    setStats((st) => ({ ...st, [card.id]: ns }))
    supabase.from('card_stats').upsert(ns).then(() => {})
    if (idx + 1 >= queue.length) finish(all)
    else setIdx(idx + 1)
  }

  // Flip mode self-rating. A miss counts right away. "Got it" / "Unsure" earn nothing yet:
  // the card returns a few cards later as an auto-graded quick check, and that result is what counts.
  function claim(item, rating, ms) {
    if (rating === 'wrong') return answer(item, 'wrong', ms, 'self')
    const at = Math.min(queue.length, idx + 1 + 4)
    const nq = [...queue]
    nq.splice(at, 0, { card: item.card, verify: true, selfRating: rating })
    setQueue(nq)
    setIdx(idx + 1)
  }

  function retryMissed() {
    const missed = results.filter((r) => r.result !== 'correct').map((r) => r.card)
    sessionId.current = null
    supabase.from('sessions').insert({ user_id: profile.id, deck_id: id, mode: cfg.mode })
      .select().single().then(({ data }) => {
        sessionId.current = data?.id
        startedAt.current = Date.now()
        activeSec.current = 0
        resultsRef.current = []
        setQueue(buildQueue(missed, stats, { order: 'random' }).map((card) => ({ card })))
        setIdx(0)
        setResults([])
        setPhase('run')
      })
  }

  if (!deck) return <p className="muted">Loading...</p>

  if (phase === 'setup') {
    return (
      <>
        <p><Link to={`/deck/${id}`}>&larr; Back to deck</Link></p>
        <h2>Study: {deck.title}</h2>
        <div className="grid">
          {MODES.map((m) => (
            <button key={m.id} className={`card choice ${cfg.mode === m.id ? 'on' : ''}`} onClick={() => setCfg({ ...cfg, mode: m.id })}>
              <b>{m.label}</b><span>{m.help}</span>
            </button>
          ))}
        </div>
        <div className="card row">
          <label>How many cards
            <select value={cfg.count} onChange={(e) => setCfg({ ...cfg, count: e.target.value })}>
              <option value={10}>10</option>
              <option value={20}>20</option>
              <option value={30}>30</option>
              <option value={0}>All ({cards.length})</option>
            </select>
          </label>
          {cfg.mode !== 'test' && (
            <label>Order
              <select value={cfg.order} onChange={(e) => setCfg({ ...cfg, order: e.target.value })}>
                <option value="smart">Smart (due and weak cards first)</option>
                <option value="random">Totally random</option>
              </select>
            </label>
          )}
          <label>Question types
            <select value={cfg.kind} onChange={(e) => setCfg({ ...cfg, kind: e.target.value })}>
              <option value="all">Everything ({cards.length})</option>
              <option value="term" disabled={!cards.some((c) => (c.kind || 'term') === 'term')}>Definitions only ({cards.filter((c) => (c.kind || 'term') === 'term').length})</option>
              <option value="scenario" disabled={!cards.some((c) => c.kind === 'scenario')}>Application questions only ({cards.filter((c) => c.kind === 'scenario').length})</option>
            </select>
          </label>
          <button className="primary big" onClick={start} disabled={!poolOf().length}>Start</button>
        </div>
      </>
    )
  }

  if (phase === 'done') {
    const missed = results.filter((r) => r.result !== 'correct')
    return (
      <>
        <h2>{cfg.mode === 'test' ? 'Test score' : 'Session done'}</h2>
        <div className="card score">
          <div className="big-num">{summary.score}%</div>
          <p>{summary.correct} right, {summary.unsure} unsure, {summary.wrong} missed. {fmtMin(summary.seconds)} of study time.</p>
        </div>
        {missed.length > 0 && (
          <section className="card">
            <h3>Review these</h3>
            {missed.map((r) => (
              <div key={r.card.id} className="review"><b>{r.card.front}</b><span>{r.card.back}</span>{r.card.explanation && <span>{r.card.explanation}</span>}</div>
            ))}
            <button className="primary" onClick={retryMissed}>Practice the {missed.length} I missed</button>
          </section>
        )}
        <div className="row">
          <button onClick={() => { setPhase('setup'); setSummary(null) }}>Go again</button>
          <button onClick={() => nav('/')}>Home</button>
        </div>
      </>
    )
  }

  const item = queue[idx]
  const card = item.card
  const feedback = cfg.mode !== 'test'
  return (
    <>
      <div className="row between">
        <span className="muted">{idx + 1} of {queue.length}</span>
        <button className="link" onClick={() => finish(resultsRef.current)}>End early</button>
      </div>
      <div className="bar"><i style={{ width: `${(idx / queue.length) * 100}%` }} /></div>
      <Question key={`${card.id}-${idx}`} card={card} kind={kindFor(item)} feedback={feedback} verify={!!item.verify} allowOverride={!item.verify} allCards={cards} onAnswer={(r, ms, method) => answer(item, r, ms, method)} onClaim={(rating, ms) => claim(item, rating, ms)} />
    </>
  )
}

function Question({ card, kind, feedback, verify, allowOverride, allCards, onAnswer, onClaim }) {
  const t0 = useRef(Date.now())
  const [revealed, setRevealed] = useState(false)
  const [picked, setPicked] = useState(null)
  const [typed, setTyped] = useState('')
  const [checked, setChecked] = useState(null) // true/false after checking typed answer
  const choices = useMemo(() => (kind === 'mc' ? makeChoices(card, allCards) : null), [card, kind, allCards])
  const ms = () => Date.now() - t0.current
  const expl = card.explanation ? <p className="expl">{card.explanation}</p> : null
  const banner = verify ? <p className="badge">Quick check: show you really know it</p> : null

  if (kind === 'flip') {
    return (
      <div className="card flash" onClick={() => setRevealed(true)}>
        <p className="q">{card.front}</p>
        {revealed ? (
          <>
            <p className="a">{card.back}</p>
            {expl}
            <div className="row center-row">
              <button className="bad" onClick={(e) => { e.stopPropagation(); onClaim('wrong', ms()) }}>Missed it</button>
              <button onClick={(e) => { e.stopPropagation(); onClaim('unsure', ms()) }}>Unsure</button>
              <button className="good" onClick={(e) => { e.stopPropagation(); onClaim('correct', ms()) }}>Got it</button>
            </div>
            <p className="muted">Got it and Unsure come back as a quick check. Only the check counts.</p>
          </>
        ) : (
          <p className="muted">Tap to flip</p>
        )}
      </div>
    )
  }

  if (kind === 'mc') {
    const done = picked !== null
    return (
      <div className="card flash">
        {banner}
        <p className="q">{card.front}</p>
        <div className="choices">
          {choices.map((c) => (
            <button
              key={c}
              disabled={done && feedback}
              className={done && feedback ? (c === card.back ? 'good' : c === picked ? 'bad' : '') : ''}
              onClick={() => {
                if (!feedback) return onAnswer(c === card.back ? 'correct' : 'wrong', ms())
                setPicked(c)
              }}
            >{c}</button>
          ))}
        </div>
        {done && feedback && (
          <>
            {expl}
            <button className="primary" onClick={() => onAnswer(picked === card.back ? 'correct' : 'wrong', ms())}>Next</button>
          </>
        )}
      </div>
    )
  }

  // type
  function check(e) {
    e.preventDefault()
    const ok = typedMatch(typed, card.back)
    if (!feedback) return onAnswer(ok ? 'correct' : 'wrong', ms())
    setChecked(ok)
  }
  return (
    <div className="card flash">
      {banner}
      <p className="q">{card.front}</p>
      {checked === null ? (
        <form className="row" onSubmit={check}>
          <input autoFocus value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="Type your answer" />
          <button className="primary">Check</button>
        </form>
      ) : (
        <>
          <p className={checked ? 'good-text' : 'bad-text'}>{checked ? 'Correct' : 'Not quite'}</p>
          <p className="a">{card.back}</p>
          {expl}
          <div className="row center-row">
            {!checked && allowOverride && <button onClick={() => onAnswer('correct', ms(), 'override')}>I was right</button>}
            <button className="primary" onClick={() => onAnswer(checked ? 'correct' : 'wrong', ms())}>Next</button>
          </div>
        </>
      )}
    </div>
  )
}
