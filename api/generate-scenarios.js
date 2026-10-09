import { admin, requireUser } from './_lib/auth.js'

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5'
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

function parseJson(text) {
  let t = String(text || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
  const start = t.indexOf('[')
  if (start === -1) throw new Error('Model did not return a question list')
  t = t.slice(start)
  try {
    return JSON.parse(t)
  } catch {
    const cut = t.lastIndexOf('}')
    if (cut === -1) throw new Error('Could not parse questions')
    return JSON.parse(t.slice(0, cut + 1) + ']')
  }
}

function buildPrompt({ deck, grade, terms, count, existing }) {
  const level = grade ? `a student in grade ${grade}` : 'a middle or high school student'
  const subject = deck.subject ? ` (${deck.subject})` : ''
  const list = terms.map((c) => `- ${c.front}: ${c.back}`).join('\n')
  const seen = existing.length ? `\nDo not repeat or closely paraphrase these existing questions:\n${existing.map((e) => `- ${e}`).join('\n')}\n` : ''
  return `You are writing practice questions for ${level}. Deck: "${deck.title}"${subject}.
Below are the vocabulary terms and definitions the student must know. Write ${count} application questions in the style of AP exam stimulus-based multiple choice. Each one gives a short realistic scenario, or describes a map, graph, or data set in words, and asks which term or concept it illustrates or which one applies. The student cannot see images, so describe any visual in the question text.

Rules:
- The correct answer must be exactly one of the listed terms, written exactly as listed.
- The 3 wrong answers must also be listed terms, chosen because they are the most easily confused with the right one (similar sounding or closely related concepts). Never use a wrong answer that could also be correct for the scenario.
- Do not put the answer term, or wording copied from its definition, in the question.
- Spread questions across as many different terms as possible, starting with the terms students most often confuse.
- "explanation": one or two sentences on why the answer is right and why the closest wrong answer is not.
- Vary the scenarios and settings.
${seen}
Return ONLY a JSON array, no commentary, no code fences. Each item:
{"stem": "...", "answer": "<term>", "wrong": ["<term>", "<term>", "<term>"], "explanation": "..."}

TERMS:
${list}`
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })
  const me = await requireUser(req)
  if (!me) return res.status(401).json({ error: 'Not signed in' })

  const { deckId } = req.body || {}
  const count = Math.min(Math.max(parseInt(req.body?.count, 10) || 20, 5), 30)

  try {
    const { data: deck } = await admin.from('decks').select('*').eq('id', deckId).single()
    if (!deck) return res.status(404).json({ error: 'Deck not found' })
    if (deck.owner_id !== me.id && me.role !== 'admin') return res.status(403).json({ error: 'Not your deck' })

    const { data: termCards } = await admin
      .from('cards').select('id,front,back')
      .eq('deck_id', deck.id).eq('kind', 'term').eq('status', 'active').limit(200)
    const terms = termCards || []
    if (terms.length < 4) return res.status(400).json({ error: 'Add and approve at least 4 definition cards first.' })

    const { data: old } = await admin
      .from('cards').select('front').eq('deck_id', deck.id).eq('kind', 'scenario').limit(80)
    const existing = (old || []).map((o) => o.front.slice(0, 160))
    const { data: owner } = await admin.from('profiles').select('grade').eq('id', deck.owner_id).single()

    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 8000,
        messages: [{ role: 'user', content: buildPrompt({ deck, grade: owner?.grade, terms, count, existing }) }]
      })
    })
    const json = await resp.json()
    if (!resp.ok) throw new Error(json?.error?.message || `Anthropic API error ${resp.status}`)

    const byNorm = new Map(terms.map((c) => [norm(c.front), c]))
    const rows = []
    for (const q of parseJson(json.content?.map((b) => b.text || '').join(''))) {
      const concept = byNorm.get(norm(q?.answer))
      if (!q?.stem || !concept) continue // the answer must be a real term from the deck
      const wrong = [...new Set((q.wrong || []).map((w) => byNorm.get(norm(w))?.front || String(w)))]
        .filter((w) => norm(w) !== norm(concept.front))
        .slice(0, 3)
      if (wrong.length < 2) continue
      rows.push({
        deck_id: deck.id,
        owner_id: deck.owner_id,
        kind: 'scenario',
        front: String(q.stem).trim(),
        back: concept.front,
        wrong_answers: wrong,
        explanation: q.explanation ? String(q.explanation).trim() : null,
        concept_card_id: concept.id,
        status: 'pending'
      })
    }
    if (!rows.length) throw new Error('No usable questions came back. Try again.')

    const { error } = await admin.from('cards').insert(rows)
    if (error) throw new Error(error.message)
    return res.json({ ok: true, count: rows.length })
  } catch (e) {
    return res.status(500).json({ error: e.message })
  }
}
