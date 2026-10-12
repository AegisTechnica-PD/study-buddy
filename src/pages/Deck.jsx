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

  // Phone photos are huge and often HEIC. Redraw to a JPEG no wider than 1800px so the upload is small and always readable.
  async function toJpeg(file) {
    const url = URL.createObjectURL(file)
    try {
      const img = await new Promise((ok, no) => {
        const i = new Image()
        i.onload = () => ok(i)
        i.onerror = () => no(new Error(`Could not open ${file.name}. Try taking the photo again.`))
        i.src = url
      })
      const scale = Math.min(1, 1800 / Math.max(img.naturalWidth, img.naturalHeight))
      const c = document.createElement('canvas')
      c.width = Math.round(img.naturalWidth * scale)
      c.height = Math.round(img.naturalHeight * scale)
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height)
      const blob = await new Promise((ok) => c.toBlob(ok, 'image/jpeg', 0.85))
      if (!blob) throw new Error('Could not process the photo.')
      return blob
    } finally {
      URL.revokeObjectURL(url)
    }
  }

  async function uploadFiles(e) {
    const files = Array.from(e.target.files || [])
    e.target.value = ''
    if (!files.length) return
    const pdfs = files.filter((f) => f.type === 'application/pdf')
    const imgs = files.filter((f) => f.type.startsWith('image/') || /\.(heic|heif|jpe?g|png)$/i.test(f.name))
    if (pdfs.length + imgs.length !== files.length) return setMsg('Choose PDFs or photos only.')
    if (pdfs.length && imgs.length) return setMsg('Choose either one PDF or a set of photos, not both at once.')
    if (pdfs.length > 1) return setMsg('Upload one PDF at a time.')
    if (pdfs[0] && pdfs[0].size > 20 * 1024 * 1024) return setMsg('That PDF is over 20 MB. Split it into smaller files.')
    if (imgs.length > 30) return setMsg('Up to 30 photos at a time.')
    setMsg('')
    let total = 0
    let failed = 0
    const queue = pdfs.length ? pdfs : imgs
    for (let i = 0; i < queue.length; i++) {
      const file = queue[i]
      const isPdf = file.type === 'application/pdf'
      const label = isPdf ? 'PDF' : `photo ${i + 1} of ${queue.length}`
      try {
        setBusy(`Uploading ${label}...`)
        const body = isPdf ? file : await toJpeg(file)
        const safe = file.name.replace(/\.[^.]*$/, '').replace(/[^a-zA-Z0-9._-]/g, '_') || 'photo'
        const path = `${deck.owner_id}/${deck.id}/${Date.now()}-${i}-${safe}${isPdf ? '.pdf' : '.jpg'}`
        const up = await supabase.storage.from('pdfs').upload(path, body, { contentType: isPdf ? 'application/pdf' : 'image/jpeg' })
        if (up.error) throw up.error
        const { data: src, error } = await supabase
          .from('sources')
          .insert({ deck_id: deck.id, owner_id: deck.owner_id, filename: file.name, storage_path: path })
          .select()
          .single()
        if (error) throw error
        setBusy(isPdf ? 'Reading the PDF and writing cards. This can take up to a minute...' : `Reading ${label}...`)
        const r = await callApi('/api/generate-cards', { sourceId: src.id, mode })
        total += r.count
        if (r.capped) setMsg('This file hit the card limit, so some cards may be missing. Upload the rest as a second file.')
      } catch (err) {
        failed++
        setMsg(`Something went wrong with ${label}: ${err.message}`)
      }
    }
    if (!failed) setMsg((m) => `Added ${total} cards to review below.${m.startsWith('This file hit') ? ' ' + m : ''}`)
    else setMsg((m) => `${m} Added ${total} cards from the rest.`)
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
          <label><input type="radio" checked={mode === 'extract'} onChange={() => setMode('extract')} /> This already has flashcards (PDF or photos of them), copy them as written</label>
        </div>
        <input type="file" accept="application/pdf,image/*" multiple onChange={uploadFiles} disabled={!!busy} />
        <p className="muted">On a phone, choose Take Photo or Photo Library. You can pick several photos at once, one flashcard or page each. Check the review list afterward.</p>
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
