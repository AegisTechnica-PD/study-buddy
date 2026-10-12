import { admin, requireUser } from './_lib/auth.js'

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5'
const MAX_BYTES = 20 * 1024 * 1024

const SHAPE = `Return ONLY a JSON array, no commentary, no code fences. Each item:
{"front": "...", "back": "...", "wrong": ["...", "...", "..."]}
"wrong" must hold exactly 3 plausible but incorrect answers, the SAME length and form as "back" (within about 20% of its character count; the right answer must never be the longest or most detailed one), for multiple choice.`

const PHOTOSET_NOTE = `
These are photos of physical flashcards or notes, labeled Photo 1, Photo 2 and so on. Each photo usually shows ONE SIDE of ONE card, and the photos are in no particular order. Match the sides yourself: the term side is short (often with a small number in a corner), the definition side is longer text, and the number, topic and meaning tell you which two belong together. Make one card per matched pair, with the term as "front" and the definition as "back", copied as written. A photo showing both sides of a card is one card by itself. If a side has no match among the photos, or a word is illegible, skip it. Read handwriting carefully and never guess.`

const PHOTO_NOTE = `
This is a photo, possibly of a handwritten or printed flashcard, several cards, or a page of notes. It may be tilted or show both sides of a card. Read all legible text carefully. If a photo shows one side of a card with the other side missing, make the card only if the term and answer are both visible. Never guess at illegible words; skip that card instead.`

function buildPrompt(mode, maxCards, grade) {
  const level = grade ? `a student in grade ${grade}` : 'a middle or high school student'
  if (mode === 'auto') {
    return `The attached material is from a student (${level}). First decide what it is.
A) If it is already flashcards, a vocabulary or key-terms list, or term and definition pairs: copy EVERY card exactly as written. Keep the original wording for "front" (term or question) and "back" (definition or answer). Do not add, merge, or rewrite cards. Up to ${maxCards} cards. Do not invent wrong answers.
B) If it is notes, a textbook page, or a study guide: write up to ${maxCards} high quality flashcards covering the most testable facts, definitions, concepts and cause and effect. Each "back" is a concise answer under 25 words. Use only facts in the material. No duplicates.
Return ONLY a JSON array, no commentary, no code fences. Each item: {"front": "...", "back": "...", "wrong": ["...", "...", "..."]}
For case A leave "wrong" as an empty array. For case B "wrong" holds exactly 3 plausible incorrect answers the SAME length and form as "back" (within about 20% of its character count; the right answer must never be the longest).`
  }
  if (mode === 'extract') {
    return `The attached document contains flashcards or term/definition lists made by a teacher for ${level}.
Extract every card exactly as written. Keep the teacher's wording for "front" (term or question) and "back" (definition or answer). Do not add, merge, or rewrite cards. Skip anything that is not a card. Up to ${maxCards} cards.
Return ONLY a JSON array, no commentary, no code fences. Each item: {"front": "...", "back": "..."}
Do not invent wrong answers. The app builds multiple choice options from the teacher's other cards.`
  }
  return `The attached document is study material (notes, a textbook chapter, or a study guide) for ${level}.
Write up to ${maxCards} high quality flashcards covering the most testable facts, definitions, concepts, formulas, dates, and cause and effect relationships. Spread them across the whole document. If the document is a list of key terms or vocabulary, make one card for every term listed, then use any remaining room for other testable facts.
Rules: each "front" is a clear, self-contained question or prompt. Each "back" is a concise correct answer, under 25 words. Use only facts that appear in the material. No duplicates.
${SHAPE}`
}

function parseCards(text) {
  let t = String(text || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
  const start = t.indexOf('[')
  if (start === -1) throw new Error('Model did not return a card list')
  t = t.slice(start)
  try {
    return JSON.parse(t)
  } catch {
    // Output may have been cut off at the token limit: keep the complete cards.
    const cut = t.lastIndexOf('}')
    if (cut === -1) throw new Error('Could not parse cards')
    return JSON.parse(t.slice(0, cut + 1) + ']')
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })
  const me = await requireUser(req)
  if (!me) return res.status(401).json({ error: 'Not signed in' })

  const { mode = 'generate' } = req.body || {}
  const ids = Array.isArray(req.body?.sourceIds) && req.body.sourceIds.length ? req.body.sourceIds.slice(0, 20) : [req.body?.sourceId]
  // Copying a teacher's set must not truncate it, so extract mode allows far more cards.
  const cap = mode === 'generate' ? 100 : 150
  const maxCards = Math.min(Math.max(parseInt(req.body?.maxCards, 10) || cap, 5), cap)

  const { data: sources } = await admin.from('sources').select('*').in('id', ids)
  if (!sources?.length || sources.length !== ids.length) return res.status(404).json({ error: 'Source not found' })
  const source = sources[0]
  if (sources.some((x) => x.owner_id !== me.id && me.role !== 'admin')) return res.status(403).json({ error: 'Not your file' })
  if (sources.some((x) => x.deck_id !== source.deck_id)) return res.status(400).json({ error: 'Files must be in the same deck' })

  await admin.from('sources').update({ status: 'processing', error: null }).in('id', ids)

  try {
    const blocks = []
    let anyImage = false
    for (const [i, src] of sources.entries()) {
      const { data: file, error: dlErr } = await admin.storage.from('pdfs').download(src.storage_path)
      if (dlErr) throw new Error(`Could not read the file: ${dlErr.message}`)
      const buf = Buffer.from(await file.arrayBuffer())
      if (buf.length > MAX_BYTES) throw new Error('File is over 20 MB. Split it into smaller files.')
      if (/\.txt$/i.test(src.storage_path)) {
        blocks.push({ type: 'text', text: `Material (${src.filename}):\n${buf.toString('utf8')}` })
      } else if (/\.jpe?g$/i.test(src.storage_path)) {
        anyImage = true
        blocks.push({ type: 'text', text: `Photo ${i + 1}:` })
        blocks.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: buf.toString('base64') } })
      } else {
        blocks.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buf.toString('base64') } })
      }
    }
    const note = !anyImage ? '' : sources.length > 1 ? PHOTOSET_NOTE : PHOTO_NOTE

    const { data: owner } = await admin.from('profiles').select('grade').eq('id', source.owner_id).single()

    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 16000,
        messages: [{ role: 'user', content: [...blocks, { type: 'text', text: buildPrompt(mode, maxCards, owner?.grade) + note }] }]
      })
    })
    const json = await resp.json()
    if (!resp.ok) throw new Error(json?.error?.message || `Anthropic API error ${resp.status}`)

    const raw = parseCards(json.content?.map((b) => b.text || '').join(''))
    // Skip anything already in this deck (or this upload), so overlapping page ranges never make duplicates.
    const { data: existing } = await admin.from('cards').select('front').eq('deck_id', source.deck_id).limit(5000)
    const seenFronts = new Set((existing || []).map((c) => String(c.front).trim().toLowerCase()))
    const rows = raw
      .filter((c) => c && c.front && c.back)
      .filter((c) => {
        const k = String(c.front).trim().toLowerCase()
        if (seenFronts.has(k)) return false
        seenFronts.add(k)
        return true
      })
      .slice(0, maxCards)
      .map((c) => ({
        deck_id: source.deck_id,
        owner_id: source.owner_id,
        source_id: source.id,
        front: String(c.front).trim(),
        back: String(c.back).trim(),
        wrong_answers: Array.isArray(c.wrong) ? c.wrong.slice(0, 3).map(String) : [],
        status: 'pending'
      }))
    if (!rows.length && raw.length) {
      await admin.from('sources').update({ status: 'done', card_count: 0 }).in('id', ids)
      return res.json({ ok: true, count: 0, capped: false })
    }
    if (!rows.length) throw new Error(anyImage ? 'No complete cards were found. For photos of two-sided cards, include both sides in the same upload.' : 'No cards were found in this file')

    const { error: insErr } = await admin.from('cards').insert(rows)
    if (insErr) throw new Error(insErr.message)

    await admin.from('sources').update({ status: 'done', card_count: 0 }).in('id', ids)
    await admin.from('sources').update({ card_count: rows.length }).eq('id', source.id)
    return res.json({ ok: true, count: rows.length, capped: raw.length >= maxCards })
  } catch (e) {
    await admin.from('sources').update({ status: 'error', error: e.message }).in('id', ids)
    return res.status(500).json({ error: e.message })
  }
}
