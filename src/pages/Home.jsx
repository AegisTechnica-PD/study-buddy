import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase.js'
import { useAuth } from '../auth.jsx'
import { isDue } from '../lib/srs.js'
import { dayKey, fmtMin, streak } from '../lib/stats.js'

export default function Home() {
  const { profile } = useAuth()
  const nav = useNavigate()
  const [decks, setDecks] = useState([])
  const [cards, setCards] = useState([])
  const [stats, setStats] = useState({})
  const [sessions, setSessions] = useState([])
  const [title, setTitle] = useState('')
  const [subject, setSubject] = useState('')
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    const since = new Date(Date.now() - 60 * 864e5).toISOString()
    Promise.all([
      supabase.from('decks').select('*').eq('owner_id', profile.id).order('created_at', { ascending: false }),
      supabase.from('cards').select('id,deck_id,status').eq('owner_id', profile.id),
      supabase.from('card_stats').select('card_id,box,due_at').eq('user_id', profile.id),
      supabase.from('sessions').select('started_at,active_seconds').eq('user_id', profile.id).gte('started_at', since)
    ]).then(([d, c, s, ss]) => {
      setDecks(d.data || [])
      setCards(c.data || [])
      setStats(Object.fromEntries((s.data || []).map((x) => [x.card_id, x])))
      setSessions(ss.data || [])
      setLoaded(true)
    })
  }, [profile.id])

  async function createDeck(e) {
    e.preventDefault()
    if (!title.trim()) return
    const { data, error } = await supabase
      .from('decks')
      .insert({ owner_id: profile.id, title: title.trim(), subject: subject.trim() || null })
      .select()
      .single()
    if (!error) nav(`/deck/${data.id}`)
  }

  const today = dayKey(new Date())
  const todaySec = sessions.filter((s) => dayKey(s.started_at) === today).reduce((a, s) => a + s.active_seconds, 0)
  const goal = profile.daily_goal_minutes || 20
  const pct = Math.min(100, Math.round((todaySec / 60 / goal) * 100))

  return (
    <>
      <h2>Hi {profile.display_name}</h2>
      <div className="tiles">
        <div className="tile"><b>{fmtMin(todaySec)}</b><span>studied today</span></div>
        <div className="tile"><b>{streak(sessions)}</b><span>day streak</span></div>
        <div className="tile">
          <b>{pct}%</b><span>of {goal} min goal</span>
          <div className="bar"><i style={{ width: `${pct}%` }} /></div>
        </div>
      </div>

      <Link to="/math" className="card deck">
        <h4>Math facts</h4>
        <p className="muted">Quick drills for + − × ÷. Build speed and accuracy a few minutes a day.</p>
      </Link>

      <h3>My decks</h3>
      {loaded && decks.length === 0 && <p className="muted">No decks yet. Make one below, then upload your study PDF.</p>}
      <div className="grid">
        {decks.map((d) => {
          const active = cards.filter((c) => c.deck_id === d.id && c.status === 'active')
          const due = active.filter((c) => isDue(stats[c.id])).length
          const pending = cards.filter((c) => c.deck_id === d.id && c.status === 'pending').length
          return (
            <Link key={d.id} to={`/deck/${d.id}`} className="card deck">
              <h4>{d.title}</h4>
              {d.subject && <span className="muted">{d.subject}</span>}
              <p>{active.length} cards, {due} due</p>
              {pending > 0 && <span className="badge">{pending} to review</span>}
            </Link>
          )
        })}
      </div>

      <form className="card row" onSubmit={createDeck}>
        <input placeholder="New deck name (e.g. Chapter 5 Biology)" value={title} onChange={(e) => setTitle(e.target.value)} />
        <input placeholder="Subject (optional)" value={subject} onChange={(e) => setSubject(e.target.value)} />
        <button className="primary">Create deck</button>
      </form>
    </>
  )
}
