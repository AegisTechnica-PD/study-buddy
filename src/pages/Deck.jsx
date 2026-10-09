import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { supabase } from '../lib/supabase.js'
import { callApi } from '../lib/api.js'
import { parseCardText } from '../lib/srs.js'
import { useAuth } from '../auth.jsx'
import SendCopy from './SendCopy.jsx'

export default function Deck() {
  const { id } = useParams()
  const nav = useNavigate()
  const { profile } = useAuth()
  const [deck, setDeck] = useState(null)
  const [cards, setCards] = useState([])
  const [sources, setSources] = useState([])
  const [mode, setMode] = useState('generate')
  const [busy, setBusy] = useState('')
  const [msg, setMsg] = useState('')
  const [front, setFront] = useState('')
  const [back, setBack] = useState('')
  const [paste, setPaste] = useState('')
  const [showAll, setShowAll] = useState(false)
  const [nq, setNq] = useState(20)

  const load = useCallback(async () => {
    const [d, c, s] = await Promise.all([
      supabase.from('decks').select('*').eq('id', id).single(),
      supabase.from('cards').select('*').eq('deck_id', id).order('created_at'),
      supabase.from('sources').select('*').eq('deck_id', id).order('created_at', { ascending: false })
    ])
    setDeck(d.data)
    setCards(c.data || [])
    setSources(s.data || [])
  }, [id])

  useEffect(() => { load() }, [load])

  if (!deck) return <p className="muted">Loading...</p>

  const active = cards.filter((c) => c.status === 'active')
  const pending = cards.filter((c) => c.status === 'pending')

  async function uploadPdf(e) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    if (file.type !== 'application/pdf') return setMsg('Please choose a PDF file.')
    if (file.size > 20 * 1024 * 1024) return setMsg('That PDF is over 20 MB. Split it into smaller files.')
    setMsg('')
    setBusy('Uploading PDF...')
    try {
      const safe = file.name.replace(/[^a-zA-Z0-9._-]/g, '_')
      const path = `${deck.owner_id}/${deck.id}/${Date.now()}-${safe}`
      const up = await supabase.storage.from('pdfs').upload(path, file, { contentType: 'application/pdf' })
      if (up.error) throw up.error
      const { data: src, error } = await supabase
        .from('sources')
        .insert({ deck_id: deck.id, owner_id: deck.owner_id, filename: file.name, storage_path: path })
        .select()
        .single()
      if (error) throw error
      setBusy('Reading the PDF and writing cards. This can take up to a minute...')
      const r = await callApi('/api/generate-cards', { sourceId: src.id, mode })
      setMsg(`Added ${r.count} cards to review below.`)
    } catch (err) {
      setMsg(`Something went wrong: ${err.message}`)
    }
    setBusy('')
    load()
  }

  async function addCard(e) {
    e.preventDefault()
    if (!front.trim() || !back.trim()) return
    await supabase.from('cards').insert({ deck_id: deck.id, owner_id: deck.owner_id, front: front.trim(), back: back.trim() })
    setFront('')
    setBack('')
    load()
  }

  async function importPaste() {
    const rows = parseCardText(paste)
    if (!rows.length) return setMsg('No cards found. Use one card per line: front, back (or tab separated).')
    await supabase.from('cards').insert(rows.map((r) => ({ ...r, deck_id: deck.id, owner_id: deck.owner_id })))
    setPaste('')
    setMsg(`Imported ${rows.length} cards.`)
    load()
  }

  async function makeScenarios() {
    setMsg('')
    setBusy('Writing application questions. This can take up to a minute...')
    try {
      const r = await callApi('/api/generate-scenarios', { deckId: deck.id, count: Number(nq) })
      setMsg(`Added ${r.count} application questions to review below.`)
    } catch (err) {
      setMsg(`Something went wrong: ${err.message}`)
    }
    setBusy('')
    load()
  }

  async function approveAll() {
    await supabase.from('cards').update({ status: 'active' }).eq('deck_id', deck.id).eq('status', 'pending')
    load()
  }

  async function saveCard(c, patch) {
    await supabase.from('cards').update(patch).eq('id', c.id)
  }

  async function delCard(c) {
    await supabase.from('cards').delete().eq('id', c.id)
    load()
  }

  async function delDeck() {
    if (!confirm('Delete this deck and all its cards and history?')) return
    await supabase.from('decks').delete().eq('id', deck.id)
    nav('/')
  }

  return (
    <>
      <p><Link to="/">&larr; All decks</Link></p>
      <div className="row between">
        <h2>{deck.title}</h2>
        <button className="primary big" disabled={active.length < 1} onClick={() => nav(`/study/${deck.id}`)}>
          Study ({active.length})
        </button>
      </div>
      {deck.subject && <p className="muted">{deck.subject}</p>}

      <section className="card">
        <h3>Add study material</h3>
        <div className="seg">
          <label><input type="radio" checked={mode === 'generate'} onChange={() => setMode('generate')} /> Make flashcards from my notes</label>
          <label><input type="radio" checked={mode === 'extract'} onChange={() => setMode('extract')} /> This PDF already has flashcards, copy them as written</label>
        </div>
        <input type="file" accept="application/pdf" onChange={uploadPdf} disabled={!!busy} />
        {busy && <p className="busy">{busy}</p>}
        {msg && <p className="note">{msg}</p>}
        {sources.some((s) => s.status === 'error') && (
          <p className="err">Last failed upload: {sources.find((s) => s.status === 'error').error}</p>
        )}
      </section>

      <section className="card">
        <h3>Application questions</h3>
        <p className="muted">
          Scenario questions like the ones on AP exams: a real-world situation, and the student picks the term that fits.
          Wrong answers are the look-alike terms from this deck. {cards.filter((c) => c.kind === 'scenario' && c.status === 'active').length} active
          {cards.some((c) => c.kind === 'scenario' && c.status === 'pending') ? ', more waiting for review below' : ''}.
        </p>
        <div className="row">
          <label>How many
            <select value={nq} onChange={(e) => setNq(e.target.value)}>
              <option value={10}>10</option>
              <option value={20}>20</option>
              <option value={30}>30</option>
            </select>
          </label>
          <button className="primary" onClick={makeScenarios} disabled={!!busy || cards.filter((c) => (c.kind || 'term') === 'term' && c.status === 'active').length < 4}>
            Write application questions
          </button>
        </div>
        <p className="muted">Needs at least 4 approved definition cards. Run it again for more; it avoids repeats.</p>
      </section>

      {pending.length > 0 && (
        <section className="card">
          <div className="row between">
            <h3>Review new cards ({pending.length})</h3>
            <button className="primary" onClick={approveAll}>Approve all</button>
          </div>
          <p className="muted">Fix anything wrong or delete bad cards, then approve. Edits save when you click away.</p>
          {pending.map((c) => (
            <div key={c.id} className="edit">
              <textarea defaultValue={c.front} onBlur={(e) => saveCard(c, { front: e.target.value })} />
              <textarea defaultValue={c.back} onBlur={(e) => saveCard(c, { back: e.target.value })} />
              <button className="link danger" onClick={() => delCard(c)}>Delete</button>
            </div>
          ))}
        </section>
      )}

      <section className="card">
        <h3>Add cards by hand</h3>
        <form className="row" onSubmit={addCard}>
          <input placeholder="Front (question or term)" value={front} onChange={(e) => setFront(e.target.value)} />
          <input placeholder="Back (answer)" value={back} onChange={(e) => setBack(e.target.value)} />
          <button>Add</button>
        </form>
        <details>
          <summary>Paste a list from the teacher</summary>
          <p className="muted">One card per line: front, back. Tab separated lists (from Quizlet or a spreadsheet) work too.</p>
          <textarea rows={5} value={paste} onChange={(e) => setPaste(e.target.value)} />
          <button onClick={importPaste} disabled={!paste.trim()}>Import</button>
        </details>
      </section>

      {profile.role === 'admin' && <SendCopy deck={deck} cards={cards} />}

      <section className="card">
        <div className="row between">
          <h3>Cards in this deck ({active.length})</h3>
          <button className="link" onClick={() => setShowAll(!showAll)}>{showAll ? 'Hide' : 'Show'}</button>
        </div>
        {showAll && active.map((c) => (
          <div key={c.id} className="edit">
            <textarea defaultValue={c.front} onBlur={(e) => saveCard(c, { front: e.target.value })} />
            <textarea defaultValue={c.back} onBlur={(e) => saveCard(c, { back: e.target.value })} />
            <button className="link danger" onClick={() => delCard(c)}>Delete</button>
          </div>
        ))}
      </section>

      <p><button className="link danger" onClick={delDeck}>Delete deck</button></p>
    </>
  )
}
