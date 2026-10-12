import JSZip from 'jszip'
import { parseCardText } from './srs.js'

const decode = (s) =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&')

// Text of every <p>...</p> paragraph, using the given text tag (w:t for Word, a:t for PowerPoint).
function paragraphs(xml, ptag, ttag) {
  const out = []
  const pRe = new RegExp(`<${ptag}[ >][\\s\\S]*?</${ptag}>`, 'g')
  const tRe = new RegExp(`<${ttag}(?: [^>]*)?>([\\s\\S]*?)</${ttag}>|<(?:w:tab|w:br)\\s*/>`, 'g')
  for (const p of xml.match(pRe) || []) {
    let line = ''
    let m
    tRe.lastIndex = 0
    while ((m = tRe.exec(p))) line += m[1] !== undefined ? decode(m[1]) : m[0].includes('tab') ? '\t' : ' '
    if (line.trim()) out.push(line.trim())
  }
  return out
}

const countMedia = (zip) => Object.keys(zip.files).filter((n) => /^(word|ppt)\/media\//.test(n)).length

const colIndex = (ref) => [...ref.replace(/\d+/g, '')].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1

async function xlsxRows(zip) {
  const shared = []
  const ss = zip.file('xl/sharedStrings.xml')
  if (ss) {
    for (const si of (await ss.async('string')).match(/<si>[\s\S]*?<\/si>/g) || []) {
      shared.push(decode([...si.matchAll(/<t(?: [^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => m[1]).join('')))
    }
  }
  const sheets = Object.keys(zip.files).filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort((a, b) => parseInt(a.match(/(\d+)\.xml/)[1]) - parseInt(b.match(/(\d+)\.xml/)[1]))
  const rows = []
  for (const name of sheets) {
    const xml = await zip.file(name).async('string')
    for (const row of xml.match(/<row[ >][\s\S]*?<\/row>/g) || []) {
      const cells = []
      for (const c of row.match(/<c [^>]*?(?:\/>|>[\s\S]*?<\/c>)/g) || []) {
        const ref = (c.match(/ r="([A-Z]+\d+)"/) || [])[1]
        if (!ref) continue
        const type = (c.match(/ t="(\w+)"/) || [])[1]
        let val = ''
        if (type === 's') val = shared[+(c.match(/<v>(\d+)<\/v>/) || [])[1]] || ''
        else if (type === 'inlineStr') val = decode([...c.matchAll(/<t(?: [^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => m[1]).join(''))
        else val = decode((c.match(/<v>([\s\S]*?)<\/v>/) || [])[1] || '')
        cells[colIndex(ref)] = val.trim()
      }
      if (cells.some(Boolean)) rows.push(Array.from(cells, (v) => v || ''))
    }
  }
  return rows
}

const HEADER = /^(term|word|front|question|prompt|vocab(ulary)?|concept)s?$/i

// Two filled columns on nearly every row means a ready-made card list, so no AI is needed.
function asPairs(rows) {
  const good = rows.filter((r) => r[0] && r[1])
  if (rows.length < 3 || good.length < rows.length * 0.9) return null
  const pairs = good.map((r) => ({ front: r[0], back: r[1] }))
  if (HEADER.test(pairs[0].front)) pairs.shift()
  return pairs.length ? pairs : null
}

export const DOC_RE = /\.(docx|pptx|xlsx|csv|tsv|txt|md)$/i

// Returns { pairs } for a ready-made card list, or { text } for material Claude should read.
export async function readDocument(file) {
  const ext = file.name.split('.').pop().toLowerCase()
  if (ext === 'xls' || ext === 'doc' || ext === 'ppt') throw new Error(`Old .${ext} files are not supported. Save it as .${ext}x, or as a PDF, and try again.`)
  if (['csv', 'tsv', 'txt', 'md'].includes(ext)) {
    const text = await file.text()
    if (ext !== 'md') {
      const pairs = parseCardText(text)
      const lines = text.split(/\r?\n/).filter((l) => l.trim()).length
      if (pairs.length >= 3 && pairs.length >= (lines - 1) * 0.9) {
        return { pairs }
      }
    }
    return { text }
  }
  const zip = await JSZip.loadAsync(await file.arrayBuffer())
  if (ext === 'xlsx') {
    const rows = await xlsxRows(zip)
    const pairs = asPairs(rows)
    return pairs ? { pairs } : { text: rows.map((r) => r.join('\t')).join('\n') }
  }
  if (ext === 'docx') {
    const f = zip.file('word/document.xml')
    if (!f) throw new Error('That Word file could not be read.')
    return { text: paragraphs(await f.async('string'), 'w:p', 'w:t').join('\n'), images: countMedia(zip) }
  }
  const slides = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => parseInt(a.match(/(\d+)\.xml/)[1]) - parseInt(b.match(/(\d+)\.xml/)[1]))
  if (!slides.length) throw new Error('That PowerPoint file could not be read.')
  const parts = []
  for (const [i, n] of slides.entries()) parts.push(`Slide ${i + 1}:\n` + paragraphs(await zip.file(n).async('string'), 'a:p', 'a:t').join('\n'))
  return { text: parts.join('\n\n'), images: countMedia(zip) }
}

// Split long text at line breaks so every piece is a size one request can handle.
export function chunkText(text, size = 12000) {
  const out = []
  let cur = ''
  for (const line of text.split('\n')) {
    if (cur.length + line.length + 1 > size && cur) { out.push(cur); cur = '' }
    cur += line + '\n'
  }
  if (cur.trim()) out.push(cur)
  return out
}
