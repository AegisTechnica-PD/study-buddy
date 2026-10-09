import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase.js'
import { buildCopy } from '../lib/copydeck.js'

const CHUNK = 200

// Admin only: copies a deck and its approved cards to one or more students.
// Each student gets their own copy, with their own progress and scores.
export default function SendCopy({ deck, cards }) {
  const [students, setStudents] = useState(null)
  const [picked, setPicked] = useState([])
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')

  useEffect(() => {
    supabase.from('profiles').select('id,display_name,grade').eq('role', 'student').order('display_name')
      .then(({ data }) => setStudents((data || []).filter((s) => s.id !== deck.owner_id)))
  }, [deck.owner_id])

  const active = cards.filter((c) => c.status === 'active')
  const waiting = cards.length - active.length
  const toggle = (id) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]))

  async function copyTo(student) {
    let newDeckId = null
    try {
      const { data: nd, error: de } = await supabase
        .from('decks')
        .insert({ owner_id: student.id, title: deck.title, subject: deck.subject })
        .select()
        .single()
      if (de) throw de
      newDeckId = nd.id
      const { termRows, scenarioRows } = buildCopy(cards, nd.id, student.id)
      for (const rows of [termRows, scenarioRows]) {
        for (let i = 0; i < rows.length; i += CHUNK) {
          const { error } = await supabase.from('cards').insert(rows.slice(i, i + CHUNK))
          if (error) throw error
        }
      }
      return null
    } catch (e) {
      // Never leave a half-copied deck behind.
      if (newDeckId) await supabase.from('decks').delete().eq('id', newDeckId)
      return e.message || 'unknown error'
    }
  }

  async function send() {
    setMsg('')
    setErr('')
    const targets = (students || []).filter((s) => picked.includes(s.id))
    if (!targets.length || !active.length) return

    const { data: dupes } = await supabase
      .from('decks').select('owner_id').eq('title', deck.title).in('owner_id', targets.map((t) => t.id))
    if (dupes?.length) {
      const names = targets.filter((t) => dupes.some((d) => d.owner_id === t.id)).map((t) => t.display_name).join(', ')
      if (!confirm(`${names} already has a deck named "${deck.title}". Send another copy anyway?`)) return
    }

    setBusy(true)
    const ok = []
    const failed = []
    for (const t of targets) {
      const problem = await copyTo(t)
      if (problem) failed.push(`${t.display_name} (${problem})`)
      else ok.push(t.display_name)
    }
    setBusy(false)
    if (ok.length) {
      setMsg(`Sent ${active.length} cards to ${ok.join(' and ')}.`)
      setPicked((p) => p.filter((id) => !targets.some((t) => t.id === id && ok.includes(t.display_name))))
    }
    if (failed.length) setErr(`Could not copy to: ${failed.join('; ')}`)
  }

  return (
    <section className="card">
      <h3>Send a copy to a student</h3>
      <p className="muted">
        Each student gets their own copy of the {active.length} approved cards, with their own progress and scores.
        {waiting > 0 ? ` ${waiting} cards still waiting for review are not included.` : ''}
      </p>
      {students === null && <p className="muted">Loading students...</p>}
      {students && students.length === 0 && <p className="muted">No students yet. Add them in Admin, under Students.</p>}
      {students && students.length > 0 && (
        <>
          <div className="seg">
            {students.map((s) => (
              <label key={s.id}>
                <input type="checkbox" checked={picked.includes(s.id)} onChange={() => toggle(s.id)} />
                {s.display_name}{s.grade ? ` (grade ${s.grade})` : ''}
              </label>
            ))}
          </div>
          <button className="primary" onClick={send} disabled={busy || !picked.length || !active.length}>
            {busy ? 'Sending...' : 'Send copy'}
          </button>
        </>
      )}
      {msg && <p className="note">{msg}</p>}
      {err && <p className="err">{err}</p>}
    </section>
  )
}
