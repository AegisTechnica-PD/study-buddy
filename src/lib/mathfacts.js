// Math facts engine: fact generation, spaced repetition on speed + accuracy, and question picking.
// Everything is computed, so answers are always right and practice never runs out.

const DAY = 864e5
const INTERVAL = { 1: 0, 2: 1, 3: 3, 4: 7, 5: 14 } // days, by box

export const OPS = {
  add: { sym: '+', label: 'Addition', slowMs: 3000 },
  sub: { sym: '−', label: 'Subtraction', slowMs: 3000 },
  mul: { sym: '×', label: 'Multiplication', slowMs: 4000 },
  div: { sym: '÷', label: 'Division', slowMs: 4000 }
}
export const OP_LIST = ['add', 'sub', 'mul', 'div']
export const thresholdMs = (op) => OPS[op].slowMs

export const keyOf = (f) => `${f.op}|${f.a}|${f.b}`
export const textOf = (f) => `${f.a} ${OPS[f.op].sym} ${f.b}`

// A fact is { op, a, b, answer }.
// add / mul: a and b are the operands.
// sub: a is the starting number, b is what is taken away (answer is never negative).
// div: a is the dividend, b the divisor (answer is always a whole number, never divide by 0).
// Grid cell (i, j): add/mul operands i and j; sub: i = amount taken away, j = answer; div: i = answer, j = divisor.
export function factAt(op, i, j) {
  if (op === 'add') return { op, a: i, b: j, answer: i + j }
  if (op === 'mul') return { op, a: i, b: j, answer: i * j }
  if (op === 'sub') return { op, a: i + j, b: i, answer: j }
  return { op, a: i * j, b: j, answer: i }
}

export function allFacts(op, max) {
  const out = []
  for (let i = 0; i <= max; i++) {
    for (let j = op === 'div' ? 1 : 0; j <= max; j++) out.push(factAt(op, i, j))
  }
  return out
}

export const universeSize = (op, max = 12) => allFacts(op, max).length

// Correct and fast moves a fact up a box. Correct but slow keeps its box. Wrong resets to box 1.
// "Fluent" means box 4 or higher, which takes several fast answers spread over several days.
export function nextMathStat(prev, correct, ms, op) {
  const box = prev?.box || 1
  const fast = correct && ms <= thresholdMs(op)
  const nb = !correct ? 1 : fast ? Math.min(5, box + 1) : box
  const prevAvg = prev?.avg_ms
  const avg = correct ? (prevAvg ? Math.round(prevAvg * 0.7 + ms * 0.3) : Math.round(ms)) : prevAvg ?? null
  return {
    box: nb,
    due_at: new Date(Date.now() + INTERVAL[nb] * DAY).toISOString(),
    correct_count: (prev?.correct_count || 0) + (correct ? 1 : 0),
    wrong_count: (prev?.wrong_count || 0) + (correct ? 0 : 1),
    avg_ms: avg,
    last_seen: new Date().toISOString()
  }
}

const difficulty = (f) => (f.op === 'mul' ? f.a * f.b : f.op === 'add' ? f.a + f.b : f.a)

function weighted(items, w, rng) {
  const ws = items.map(w)
  let t = rng() * ws.reduce((a, b) => a + b, 0)
  for (let i = 0; i < items.length; i++) {
    t -= ws[i]
    if (t <= 0) return items[i]
  }
  return items[items.length - 1]
}

// Picks the next fact. Mix of: a few brand new facts (easiest first), facts that are due
// (weakest boxes weighted heavily), and light review of known facts. Avoids immediate repeats.
export function pickNext(pool, stats, { newLimit = 8, newCount = 0, recent = [], rng = Math.random } = {}) {
  const now = Date.now()
  let cands = pool.filter((f) => !recent.includes(keyOf(f)))
  if (cands.length < 4) cands = pool
  const fresh = []
  const due = []
  const rest = []
  for (const f of cands) {
    const s = stats[keyOf(f)]
    if (!s) fresh.push(f)
    else if (new Date(s.due_at).getTime() <= now) due.push(f)
    else rest.push(f)
  }
  if (fresh.length && newCount < newLimit && (due.length === 0 || rng() < 0.3)) {
    fresh.sort((x, y) => difficulty(x) - difficulty(y))
    return fresh[Math.floor(rng() * Math.min(6, fresh.length))]
  }
  if (due.length) return weighted(due, (f) => (6 - stats[keyOf(f)].box) ** 2, rng)
  if (rest.length) return rest[Math.floor(rng() * rest.length)]
  const any = fresh.length ? fresh : cands
  return any[Math.floor(rng() * any.length)]
}
