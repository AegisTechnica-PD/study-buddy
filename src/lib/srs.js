// Leitner-style spaced repetition, quiz helpers, and shuffling.

const DAY = 864e5
const INTERVAL_DAYS = { 1: 0, 2: 1, 3: 3, 4: 7, 5: 14 }

export function shuffle(arr) {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

// result: 'correct' | 'unsure' | 'wrong'
export function nextStat(prev, result) {
  const box = prev?.box || 1
  const nb = result === 'correct' ? Math.min(5, box + 1) : result === 'wrong' ? 1 : box
  return {
    box: nb,
    due_at: new Date(Date.now() + INTERVAL_DAYS[nb] * DAY).toISOString(),
    correct_count: (prev?.correct_count || 0) + (result === 'correct' ? 1 : 0),
    wrong_count: (prev?.wrong_count || 0) + (result === 'wrong' ? 1 : 0),
    last_seen: new Date().toISOString()
  }
}

export const isDue = (stat) => !stat || new Date(stat.due_at).getTime() <= Date.now()

// order 'smart': due cards first (random within), then the rest, weakest box first.
// order 'random': everything shuffled.
export function buildQueue(cards, stats, { order = 'smart', count = 0 } = {}) {
  let list
  if (order === 'smart') {
    const due = []
    const rest = []
    cards.forEach((c) => (isDue(stats[c.id]) ? due : rest).push(c))
    rest.sort((a, b) => stats[a.id].box - stats[b.id].box)
    list = [...shuffle(due), ...rest]
  } else {
    list = shuffle(cards)
  }
  return count > 0 ? list.slice(0, count) : list
}

export const normalize = (s) =>
  String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim()

// Forgiving comparison for typed answers. The student can still override.
export function typedMatch(input, answer) {
  const strip = (s) => normalize(s).split(' ').filter((t) => !['the', 'a', 'an'].includes(t)).join(' ')
  const a = strip(answer) || normalize(answer)
  const i = strip(input) || normalize(input)
  if (!i) return false
  if (a === i) return true
  const at = new Set(a.split(' '))
  const it = i.split(' ')
  const hit = it.filter((t) => at.has(t)).length
  return a.length > 3 && hit / at.size >= 0.75 && hit / it.length >= 0.6
}

// Returns shuffled options including the right one, or null if not enough to quiz.
export function makeChoices(card, allCards) {
  const pool = (card.wrong_answers || []).filter(Boolean).slice(0, 3)
  if (pool.length < 3) {
    const others = shuffle(
      allCards.filter((c) => c.id !== card.id && c.back !== card.back && (c.kind || 'term') === (card.kind || 'term')).map((c) => c.back)
    )
    for (const o of others) {
      if (pool.length >= 3) break
      if (!pool.includes(o)) pool.push(o)
    }
  }
  const opts = shuffle([card.back, ...pool])
  return opts.length >= 2 ? opts : null
}

// Score: correct = 1, unsure = 0.5, wrong = 0
export const resultValue = (r) => (r === 'correct' ? 1 : r === 'unsure' ? 0.5 : 0)

// Simple CSV/TSV parser for "front,back" pairs. Handles quotes and Quizlet-style tabs.
export function parseCardText(text) {
  const rows = []
  const tab = text.includes('\t')
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue
    let cells = []
    if (tab) {
      cells = line.split('\t')
    } else {
      let cur = ''
      let q = false
      for (let k = 0; k < line.length; k++) {
        const ch = line[k]
        if (ch === '"') {
          if (q && line[k + 1] === '"') { cur += '"'; k++ } else q = !q
        } else if (ch === ',' && !q) { cells.push(cur); cur = '' } else cur += ch
      }
      cells.push(cur)
    }
    const [front, back] = cells.map((c) => c.trim())
    if (front && back) rows.push({ front, back })
  }
  // Drop a header row like "front,back" or "term,definition"
  if (rows.length && /^(front|term|question)$/i.test(rows[0].front)) rows.shift()
  return rows
}
