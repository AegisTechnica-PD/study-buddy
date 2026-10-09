import { admin, requireUser } from './_lib/auth.js'

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5'
const MAX_BYTES = 20 * 1024 * 1024

const SHAPE = `Return ONLY a JSON array, no commentary, no code fences. Each item:
{"front": "...", "back": "...", "wrong": ["...", "...", "..."]}
"wrong" must hold exactly 3 plausible but incorrect answers, similar in length and form to "back", for multiple choice.`

function buildPrompt(mode, maxCards, grade) {
  const level = grade ? `a student in grade ${grade}` : 'a middle or high school student'
  if (mode === 'extract') {
    return `The attached document contains flashcards or term/definition lists made by a teacher for ${level}.
Extract every card exactly as written. Keep the teacher's wording for "front" (term or question) and "back" (definition or answer). Do not add, merge, or rewrite cards. Skip anything that is not a card. Up to ${maxCards} cards.
Return ONLY a JSON array, no commentary, no code fences. Each item: {"front": "...", "back": "..."}
Do not invent wrong answers. The app builds multiple choice options from the teacher's other cards.`
  }
  return `The attached document is study material (notes, a textbook chapter, or a study guide) for ${level}.
Write up to ${maxCards} high quality flashcards covering the most testable facts, definitions, concepts, formulas, dates, and cause and effect relationships. Spread them across the whole document.
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

  const { sourceId, mode = 'generate' } = req.body || {}
  // Copying a teacher's set must not truncate it, so extract mode allows far more cards.
  const cap = mode === 'extract' ? 150 : 60
  const maxCards = Math.min(Math.max(parseInt(req.body?.maxCards, 10) || (mode === 'extract' ? cap : 25), 5), cap)

  const { data: source } = await admin.from('sources').select('*').eq('id', sourceId).single()
  if (!source) return res.status(404).json({ error: 'Source not found' })
  if (source.owner_id !== me.id && me.role !== 'admin') return res.status(403).json({ error: 'Not your file' })

  await admin.from('sources').update({ status: 'processing', error: null }).eq('id', source.id)

  try {
    const { data: file, error: dlErr } = await admin.storage.from('pdfs').download(source.storage_path)
    if (dlErr) throw new Error(`Could not read PDF: ${dlErr.message}`)
    const buf = Buffer.from(await file.arrayBuffer())
    if (buf.length > MAX_BYTES) throw new Error('PDF is over 20 MB. Split it into smaller files.')

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
        messages: [{
          role: 'user',
          content: [
            { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buf.toString('base64') } },
            { type: 'text', text: buildPrompt(mode, maxCards, owner?.grade) }
          ]
        }]
      })
    })
    const json = await resp.json()
    if (!resp.ok) throw new Error(json?.error?.message || `Anthropic API error ${resp.status}`)

    const raw = parseCards(json.content?.map((b) => b.text || '').join(''))
    const rows = raw
      .filter((c) => c && c.front && c.back)
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
    if (!rows.length) throw new Error('No cards were found in this PDF')

    const { error: insErr } = await admin.from('cards').insert(rows)
    if (insErr) throw new Error(insErr.message)

    await admin.from('sources').update({ status: 'done', card_count: rows.length }).eq('id', source.id)
    return res.json({ ok: true, count: rows.length })
  } catch (e) {
    await admin.from('sources').update({ status: 'error', error: e.message }).eq('id', source.id)
    return res.status(500).json({ error: e.message })
  }
}
