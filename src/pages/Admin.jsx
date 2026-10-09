import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase.js'
import { callApi } from '../lib/api.js'
import { fmtMin } from '../lib/stats.js'
import Analytics from './Analytics.jsx'

export default function Admin() {
  const [students, setStudents] = useState([])
  const [week, setWeek] = useState({})
  const [selected, setSelected] = useState('')
  const [tab, setTab] = useState('analytics')

  const load = useCallback(async () => {
    const since = new Date(Date.now() - 7 * 864e5).toISOString()
    const [p, s] = await Promise.all([
      supabase.from('profiles').select('*').eq('role', 'student').order('display_name'),
      supabase.from('sessions').select('user_id,active_seconds,score_pct,started_at').gte('started_at', since)
    ])
    const list = p.data || []
    setStudents(list)
    setSelected((cur) => cur || list[0]?.id || '')
    const w = {}
    ;(s.data || []).forEach((r) => {
      const x = (w[r.user_id] ||= { sec: 0, scores: [], sessions: 0, last: null })
      x.sec += r.active_seconds
      x.sessions += 1
      if (r.score_pct !== null) x.scores.push(Number(r.score_pct))
      if (!x.last || r.started_at > x.last) x.last = r.started_at
    })
    setWeek(w)
  }, [])

  useEffect(() => { load() }, [load])

  return (
    <>
      <h2>Admin</h2>
      <div className="tabs">
        <button className={tab === 'analytics' ? 'on' : ''} onClick={() => setTab('analytics')}>Analytics</button>
        <button className={tab === 'students' ? 'on' : ''} onClick={() => setTab('students')}>Students</button>
      </div>

      {tab === 'analytics' && (
        <>
          <section className="card">
            <h3>This week at a glance</h3>
            <table>
              <thead><tr><th>Student</th><th>Time</th><th>Sessions</th><th>Avg score</th><th>Last active</th></tr></thead>
              <tbody>
                {students.map((s) => {
                  const w = week[s.id]
                  const sc = w?.scores.length ? Math.round(w.scores.reduce((a, b) => a + b, 0) / w.scores.length) : null
                  return (
                    <tr key={s.id} onClick={() => setSelected(s.id)} className="click">
                      <td>{s.display_name}</td>
                      <td>{fmtMin(w?.sec || 0)}</td>
                      <td>{w?.sessions || 0}</td>
                      <td>{sc === null ? '-' : `${sc}%`}</td>
                      <td>{w?.last ? new Date(w.last).toLocaleDateString() : 'none this week'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </section>
          {students.length > 0 && (
            <>
              <div className="row">
                <label>Student
                  <select value={selected} onChange={(e) => setSelected(e.target.value)}>
                    {students.map((s) => <option key={s.id} value={s.id}>{s.display_name}</option>)}
                  </select>
                </label>
              </div>
              {selected && <Analytics userId={selected} />}
            </>
          )}
        </>
      )}

      {tab === 'students' && <Students students={students} onChange={load} />}
    </>
  )
}

function Students({ students, onChange }) {
  const [f, setF] = useState({ username: '', displayName: '', grade: '', password: '' })
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)

  async function create(e) {
    e.preventDefault()
    setBusy(true)
    setMsg('')
    try {
      await callApi('/api/admin-users', { action: 'create', ...f })
      setMsg(`Created ${f.username}.`)
      setF({ username: '', displayName: '', grade: '', password: '' })
      onChange()
    } catch (err) {
      setMsg(err.message)
    }
    setBusy(false)
  }

  async function reset(s) {
    const password = prompt(`New password for ${s.display_name} (8+ characters):`)
    if (!password) return
    try {
      await callApi('/api/admin-users', { action: 'reset', userId: s.id, password })
      setMsg(`Password updated for ${s.display_name}.`)
    } catch (err) {
      setMsg(err.message)
    }
  }

  async function setGoal(s) {
    const v = prompt(`Daily study goal in minutes for ${s.display_name}:`, s.daily_goal_minutes)
    const n = parseInt(v, 10)
    if (!n || n < 1) return
    await supabase.from('profiles').update({ daily_goal_minutes: n }).eq('id', s.id)
    onChange()
  }

  return (
    <>
      <section className="card">
        <h3>Add a student</h3>
        <form className="row" onSubmit={create}>
          <input placeholder="Username (login)" value={f.username} onChange={(e) => setF({ ...f, username: e.target.value })} required />
          <input placeholder="Display name" value={f.displayName} onChange={(e) => setF({ ...f, displayName: e.target.value })} required />
          <input placeholder="Grade (e.g. 8)" value={f.grade} onChange={(e) => setF({ ...f, grade: e.target.value })} />
          <input placeholder="Password (8+ chars)" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} required />
          <button className="primary" disabled={busy}>Create</button>
        </form>
        {msg && <p className="note">{msg}</p>}
      </section>
      <section className="card">
        <h3>Students</h3>
        <table>
          <thead><tr><th>Name</th><th>Username</th><th>Grade</th><th>Daily goal</th><th></th></tr></thead>
          <tbody>
            {students.map((s) => (
              <tr key={s.id}>
                <td>{s.display_name}</td><td>{s.username}</td><td>{s.grade || '-'}</td><td>{s.daily_goal_minutes} min</td>
                <td><button className="link" onClick={() => reset(s)}>Reset password</button> <button className="link" onClick={() => setGoal(s)}>Set goal</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </>
  )
}
