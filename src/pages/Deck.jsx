import { PDFDocument } from 'pdf-lib'
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
  const [mode, setMode] = useState('auto')
  const [busy, setBusy] = useState('')
  const [msg, setMsg] = useState('')
  const [front, setFront] = useState('')
  const [back, setBack] = useState('')
  const [paste, setPaste] = useState('')
  const [showAll, setShowAll] = useState(false)
  const [nq, setNq] = useState(20)
  const [editing, setEditing] = useState(false)
  const [tTitle, setTTitle] = useState('')
  const [tSubject, setTSubject] = useState('')

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

  async function uploadOne(file, i, body, isPdf) {
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
    return src
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
    if (imgs.length > 40) return setMsg('Up to 40 photos at a time.')
    setMsg('')
    let total = 0
    let capped = false
    const failedParts = []
    try {
      if (pdfs.length) {
        // Long PDFs are cut into short page ranges and read one range at a time, so no single request runs out of time.
        const pdf = pdfs[0]
        let parts = [{ blob: pdf, label: '' }]
        try {
          const doc = await PDFDocument.load(await pdf.arrayBuffer(), { ignoreEncryption: true })
          const n = doc.getPageCount()
          const SIZE = 5
          if (n > SIZE) {
            parts = []
            for (let a = 0; a < n; a += SIZE) {
              const out = await PDFDocument.create()
              const pages = await out.copyPages(doc, Array.from({ length: Math.min(SIZE, n - a) }, (_, k) => a + k))
              pages.forEach((pg) => out.addPage(pg))
              parts.push({ blob: new Blob([await out.save()], { type: 'application/pdf' }), label: ` (pages ${a + 1}-${Math.min(a + SIZE, n)})` })
            }
          }
        } catch (_) {
          parts = [{ blob: pdf, label: '' }]
        }
        for (let i = 0; i < parts.length; i++) {
          const where = parts.length > 1 ? `part ${i + 1} of ${parts.length}` : 'the PDF'
          try {
            setBusy(`Uploading ${where}...`)
            const named = { name: pdf.name.replace(/\.pdf$/i, '') + parts[i].label + '.pdf' }
            const src = await uploadOne(named, i, parts[i].blob, true)
            setBusy(`Reading ${where} and writing cards. Keep this page open...`)
            const r = await callApi('/api/generate-cards', { sourceId: src.id, mode, maxCards: parts.length > 1 ? 40 : undefined })
            total += r.count
            capped = capped || r.capped
          } catch (err) {
            if (parts.length === 1) throw err
            failedParts.push(`${i + 1}`)
          }
        }
        if (failedParts.length) throw new Error(`part ${failedParts.join(', ')} of ${parts.length} could not be read, so some cards may be missing. Try uploading those pages again`)
      } else {
        // Photos go to Claude together, so the two sides of a physical card can be matched up.
        const ids = []
        for (let i = 0; i < imgs.length; i++) {
          setBusy(`Preparing photo ${i + 1} of ${imgs.length}...`)
          const src = await uploadOne(imgs[i], i, await toJpeg(imgs[i]), false)
          ids.push(src.id)
        }
        for (let i = 0; i < ids.length; i += 20) {
          const chunk = ids.slice(i, i + 20)
          setBusy(`Reading photos ${i + 1} to ${i + chunk.length} of ${ids.length}. This can take up to a minute...`)
          const r = await callApi('/api/generate-cards', { sourceIds: chunk, mode })
          total += r.count
          capped = capped || r.capped
        }
      }
      setMsg(`Added ${total} cards to review below.${capped ? ' This hit the card limit, so some may be missing. Upload the rest separately.' : ''}`)
    } catch (err) {
      setMsg(`Something went wrong: ${err.message}${total ? ` (${total} cards were added before that.)` : ''}`)
    }
    setBusy('')
    load()
  }

  function startEdit() {
    setTTitle(deck.title)
    setTSubject(deck.subject || '')
    setEditing(true)
  }

  async function saveEdit(e) {
    e.preventDefault()
    if (!tTitle.trim()) return
    const patch = { title: tTitle.trim(), subject: tSubject.trim() || null }
    const { error } = await supabase.from('decks').update(patch).eq('id', deck.id)
    if (error) return setMsg(`Could not rename: ${error.message}`)
    setEditing(false)
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
      {editing ? (
        <form className="card row" onSubmit={saveEdit}>
          <input autoFocus value={tTitle} onChange={(e) => setTTitle(e.target.value)} placeholder="Deck name" aria-label="Deck name" />
          <input value={tSubject} onChange={(e) => setTSubject(e.target.value)} placeholder="Subject (optional)" aria-label="Subject" />
          <button className="primary" disabled={!tTitle.trim()}>Save</button>
          <button type="button" onClick={() => setEditing(false)}>Cancel</button>
        </form>
      ) : (
        <>
          <div className="row between">
            <h2 className="titleedit">
              {deck.title}
              <button type="button" className="iconbtn" onClick={startEdit} aria-label="Edit deck name" title="Edit deck name">
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>
              </button>
            </h2>
            <button className="primary big" disabled={active.length < 1} onClick={() => nav(`/study/${deck.id}`)}>
              Study ({active.length})
            </button>
          </div>
          {deck.subject && <p className="muted">{deck.subject}</p>}
        </>
      )}

      <section className="card">
        <h3>Add cards</h3>
        <label className="pick">
          <b>Choose photos or a PDF</b>
          <span>Photos of flashcards or notes, or a PDF. Pick them all at once.</span>
          <span className="rule">Flashcards need two photos each, front and back, and both sides must have the same number written on them.</span>
          <input type="file" accept="application/pdf,image/*" multiple onChange={uploadFiles} disabled={!!busy} />
        </label>
        {busy && <p className="busy">{busy}</p>}
        {msg && <p className="note">{msg}</p>}
        {sources.some((s) => s.status === 'error') && !msg && (
          <p className="err">Last failed upload: {sources.find((s) => s.status === 'error').error}</p>
        )}
        <details>
          <summary>Not what you wanted?</summary>
          <div className="seg">
            <label><input type="radio" checked={mode === 'auto'} onChange={() => setMode('auto')} /> Figure it out (default)</label>
            <label><input type="radio" checked={mode === 'extract'} onChange={() => setMode('extract')} /> Copy the flashcards exactly as written</label>
            <label><input type="radio" checked={mode === 'generate'} onChange={() => setMode('generate')} /> Write new flashcards from my notes</label>
          </div>
        </details>
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
