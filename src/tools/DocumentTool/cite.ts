import { extname } from 'node:path'
import { createDocument } from './create.js'
import { documentSchema, type DocumentInput, type DocumentProduct, type Reference } from './schema.js'
import type { DocumentIO } from './DocumentTool.js'

const CITATION_SOURCES = {
  apa: 'https://github.com/citation-style-language/styles/blob/master/apa.csl',
  ieee: 'https://github.com/citation-style-language/styles/blob/master/ieee.csl',
  chicago: 'https://github.com/citation-style-language/styles/blob/master/chicago-author-date.csl',
  harvard: 'https://github.com/citation-style-language/styles/blob/master/harvard-cite-them-right.csl',
}
const CROSSREF_TERMS = 'Crossref bibliographic metadata is publicly available without sign-up and may be used for any purpose; abstracts can carry publisher or author copyright. This tool requests bibliographic fields, not abstracts. https://www.crossref.org/documentation/retrieve-metadata/rest-api/'
const CITATION_SCOPE = 'Basic journal-article and book references, formatted locally; not a CSL processor. Preserve supplied title capitalisation. Chicago uses author-date; Harvard uses author-date. Check journal-specific requirements before submission.'

function splitNames(value: string): string[] {
  const names: string[] = []
  let depth = 0, start = 0
  for (let i = 0; i < value.length; i++) {
    if (value[i] === '\\') { i++; continue }
    if (value[i] === '{') depth++
    else if (value[i] === '}') depth--
    else if (depth === 0 && /^\s+and\s+/i.test(value.slice(i))) {
      const separator = /^\s+and\s+/i.exec(value.slice(i))![0]
      names.push(value.slice(start, i).trim()); i += separator.length - 1; start = i + 1
    }
  }
  names.push(value.slice(start).trim())
  return names.filter(Boolean)
}
function cleanTex(value: string): string {
  return value.replace(/\\(["'`^~=.uvHck])\{?([a-zA-Z])\}?/g, (_m, accent: string, char: string) => (char + ({ '"': '\u0308', "'": '\u0301', '`': '\u0300', '^': '\u0302', '~': '\u0303', '=': '\u0304', '.': '\u0307', u: '\u0306', v: '\u030c', H: '\u030b', c: '\u0327', k: '\u0328' } as Record<string, string>)[accent]).normalize('NFC')).replace(/\\(?:textit|textbf|emph|url)\s*/g, '').replace(/\\([&%_$#{}])/g, '$1').replace(/[{}]/g, '').replaceAll('~', ' ').replaceAll('--', '–').trim()
}
export function parseBibtex(source: string): Reference[] {
  let i = 0
  const macros = new Map<string, string>([['jan', 'January'], ['feb', 'February'], ['mar', 'March'], ['apr', 'April'], ['may', 'May'], ['jun', 'June'], ['jul', 'July'], ['aug', 'August'], ['sep', 'September'], ['oct', 'October'], ['nov', 'November'], ['dec', 'December']])
  const records: { id: string; fields: Record<string, string> }[] = []
  const whitespace = (): void => { while (i < source.length) { if (/\s/.test(source[i]!)) i++; else if (source[i] === '%') { while (i < source.length && source[i] !== '\n') i++ } else break } }
  const token = (): string => { whitespace(); const match = /^[\w:./+-]+/.exec(source.slice(i)); if (!match) throw new Error(`BibTeX expected a name at character ${i}`); i += match[0].length; return match[0] }
  const atom = (): string => {
    whitespace()
    const opening = source[i]
    if (opening !== '{' && opening !== '"') { const name = token(); if (/^\d+$/.test(name)) return name; if (!macros.has(name.toLowerCase())) throw new Error(`Unknown BibTeX string: ${name}`); return macros.get(name.toLowerCase())! }
    i++
    let depth = opening === '{' ? 1 : 0, out = ''
    while (i < source.length) {
      const c = source[i++]!
      if (c === '\\') { out += c + (source[i++] ?? ''); continue }
      if (c === '{') depth++
      if (c === '}') { depth--; if (opening === '{' && depth === 0) return out }
      if (c === '"' && opening === '"' && depth === 0) return out
      out += c
    }
    throw new Error('Unclosed BibTeX value')
  }
  const value = (): string => { let text = atom(); whitespace(); while (source[i] === '#') { i++; text += atom(); whitespace() } return text }
  while (i < source.length) {
    whitespace(); if (i >= source.length) break
    if (source[i++] !== '@') throw new Error(`BibTeX expected @ at character ${i - 1}`)
    const kind = token().toLowerCase(); whitespace()
    const open = source[i++]
    if (open !== '{' && open !== '(') throw new Error('BibTeX entry requires braces or parentheses')
    const close = open === '{' ? '}' : ')'
    if (kind === 'comment') { let depth = 1; while (i < source.length && depth) { const c = source[i++]; if (c === '\\') i++; else if (c === open) depth++; else if (c === close) depth-- } if (depth) throw new Error('Unclosed BibTeX comment'); continue }
    if (kind === 'preamble') { value(); whitespace(); if (source[i++] !== close) throw new Error('Unclosed BibTeX preamble'); continue }
    if (kind === 'string') { const name = token(); whitespace(); if (source[i++] !== '=') throw new Error('BibTeX string requires ='); macros.set(name.toLowerCase(), value()); if (source[i] === ',') i++; whitespace(); if (source[i++] !== close) throw new Error('Unclosed BibTeX string'); continue }
    const id = token(); whitespace()
    if (source[i++] !== ',') throw new Error(`BibTeX ${id} requires fields`)
    const fields: Record<string, string> = {}
    while (i < source.length) {
      whitespace(); if (source[i] === close) { i++; break }
      const key = token().toLowerCase(); whitespace()
      if (source[i++] !== '=') throw new Error(`BibTeX field ${key} requires =`)
      fields[key] = value(); whitespace()
      if (source[i] === ',') i++
      else if (source[i] !== close) throw new Error(`BibTeX field ${key} requires a comma`)
    }
    if (source[i - 1] !== close) throw new Error(`Unclosed BibTeX entry ${id}`)
    records.push({ id, fields })
  }
  const fieldsFor = (record: typeof records[number], seen = new Set<string>()): Record<string, string> => {
    if (seen.has(record.id)) throw new Error('Cyclic BibTeX crossref')
    seen.add(record.id)
    const parent = record.fields.crossref ? records.find(r => r.id === record.fields.crossref) : undefined
    if (record.fields.crossref && !parent) throw new Error(`Missing BibTeX crossref: ${record.fields.crossref}`)
    return { ...(parent ? fieldsFor(parent, seen) : {}), ...record.fields }
  }
  return records.map(record => {
    const f = fieldsFor(record)
    if (!f.title) throw new Error(`BibTeX ${record.id} has no title`)
    const authors = splitNames(f.author ?? '').map(name => {
      if (/^\{.*\}$/.test(name)) return { family: cleanTex(name) }
      const comma = name.split(',').map(s => s.trim())
      if (comma.length > 1) return { family: cleanTex(comma[0]!), given: cleanTex(comma[comma.length - 1]!) }
      const words = name.trim().split(/\s+/)
      let family = words.pop() ?? ''
      while (words.length && /^[a-z]/.test(words[words.length - 1]!)) family = `${words.pop()} ${family}`
      return { family: cleanTex(family), given: cleanTex(words.join(' ')) }
    })
    const optional = Object.fromEntries(Object.entries({ year: f.year, container: f.journal ?? f.booktitle, volume: f.volume, issue: f.number, pages: f.pages, publisher: f.publisher, doi: f.doi, url: f.url }).filter((entry): entry is [string, string] => entry[1] !== undefined).map(([key, text]) => [key, cleanTex(text)]))
    return { id: record.id, title: cleanTex(f.title), authors, ...optional }
  })
}
export async function resolveDois(dois: string[], signal: AbortSignal): Promise<Reference[]> {
  const refs: Reference[] = []
  for (const raw of dois) {
    const doi = raw.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '')
    if (!/^10\.\d{4,9}\/\S+$/i.test(doi)) throw new Error(`Invalid DOI: ${raw}`)
    signal.throwIfAborted()
    const response = await fetch(`https://api.crossref.org/works/${encodeURIComponent(doi)}`, { signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]), redirect: 'error', headers: { Accept: 'application/json', 'User-Agent': 'Mercury-Document/1.0 (https://mercury-cli.ai)' } })
    if (!response.ok) throw new Error(`Crossref ${response.status} for ${doi}${response.headers.get('retry-after') ? `; retry after ${response.headers.get('retry-after')}` : ''}`)
    const body = await response.json() as { message?: Record<string, unknown> }
    const m = body.message
    if (!m || !Array.isArray(m.title) || typeof m.title[0] !== 'string') throw new Error(`Crossref returned no title for ${doi}`)
    const first = (v: unknown): string | undefined => Array.isArray(v) && typeof v[0] === 'string' ? v[0] : undefined
    const authors = Array.isArray(m.author) ? m.author.map(a => a as Record<string, unknown>).map(a => ({ family: typeof a.family === 'string' ? a.family : typeof a.name === 'string' ? a.name : '', ...(typeof a.given === 'string' ? { given: a.given } : {}) })).filter(a => a.family !== '') : []
    const issued = m.issued as { 'date-parts'?: number[][] } | undefined
    refs.push({ id: doi, doi, title: m.title[0], authors, year: issued?.['date-parts']?.[0]?.[0]?.toString(), container: first(m['container-title']), ...Object.fromEntries(['volume', 'issue', 'publisher'].flatMap(key => typeof m[key] === 'string' ? [[key, m[key]]] : [])), ...(typeof m.page === 'string' ? { pages: m.page } : {}) })
  }
  return refs
}
function yearSuffix(index: number): string {
  let n = index + 1, suffix = ''
  while (n > 0) { n--; suffix = String.fromCharCode(97 + n % 26) + suffix; n = Math.floor(n / 26) }
  return suffix
}
const initials = (given = ''): string => given.split(/[\s-]+/).filter(Boolean).map(s => `${s[0]!.toUpperCase()}.`).join(' ')
const list = (names: string[], and: string): string => names.length < 2 ? names.join('') : names.length === 2 ? names.join(` ${and} `) : `${names.slice(0, -1).join(', ')}, ${and} ${names[names.length - 1]}`
const md = (text: string): string => text.replace(/[\\`*_\[\]<>]/g, '\\$&').replaceAll(/[\r\n]+/g, ' ')
export function formatReferences(references: Reference[], style: NonNullable<DocumentInput['style']>) {
  const seen = new Set<string>()
  for (const r of references) { if (!r.id || !r.title || seen.has(r.id)) throw new Error(`Missing title or duplicate reference id: ${r.id}`); seen.add(r.id) }
  const ordered = style === 'ieee' ? references : [...references].sort((a, b) => (a.authors[0]?.family ?? a.title).localeCompare(b.authors[0]?.family ?? b.title, 'en') || (a.year ?? '').localeCompare(b.year ?? '') || a.title.localeCompare(b.title, 'en'))
  const collisions = new Map<string, Reference[]>()
  for (const r of ordered) { const key = `${r.authors.map(a => a.family).join('|')}|${r.year ?? 'n.d.'}`; collisions.set(key, [...(collisions.get(key) ?? []), r]) }
  const years = new Map<string, string>()
  for (const group of collisions.values()) group.forEach((r, i) => years.set(r.id, (r.year ?? 'n.d.') + (group.length > 1 && style !== 'ieee' ? yearSuffix(i) : '')))
  const keys: { id: string; inText: string }[] = []
  const entries = ordered.map((r, index) => {
    const year = years.get(r.id)!, title = md(r.title), container = r.container ? md(r.container) : undefined
    const family = r.authors.map(a => md(a.family))
    const names = r.authors.map(a => `${md(a.family)}${a.given ? `, ${initials(a.given)}` : ''}`)
    const link = r.doi ? `https://doi.org/${r.doi.replace(/^https?:\/\/doi\.org\//i, '')}` : r.url && /^https?:\/\//i.test(r.url) ? r.url : ''
    const pages = r.pages?.replaceAll('--', '–').replace(/(\d)-(\d)/g, '$1–$2')
    const short = family.length > 2 ? `${family[0]} et al.` : list(family, style === 'apa' ? '&' : 'and') || title
    keys.push({ id: r.id, inText: style === 'ieee' ? `[${index + 1}]` : `(${short}${style === 'chicago' ? ' ' : ', '}${year})` })
    if (style === 'apa') {
      const author = names.length > 20 ? `${names.slice(0, 19).join(', ')}, … ${names[names.length - 1]}` : list(names, '&')
      return `${author || title} (${year}). ${author ? (container ? `${title}.` : `*${title}*.`) : ''} ${container ? `*${container}${r.volume ? `, ${r.volume}` : ''}*${r.issue ? `(${r.issue})` : ''}${pages ? `, ${pages}` : ''}.` : r.publisher ? `${md(r.publisher)}.` : ''}${link ? ` ${link}` : ''}`.replaceAll(/ +/g, ' ').trim()
    }
    if (style === 'ieee') {
      const authors = r.authors.map(a => `${initials(a.given)} ${md(a.family)}`.trim())
      const author = authors.length > 6 ? `${authors[0]} et al.` : list(authors, 'and')
      return `[${index + 1}] ${author ? `${author}, ` : ''}${container ? `“${title},” *${container}*` : `*${title}*`}${r.volume ? `, vol. ${r.volume}` : ''}${r.issue ? `, no. ${r.issue}` : ''}${pages ? `, pp. ${pages}` : ''}${!container && r.publisher ? `, ${md(r.publisher)}` : ''}, ${year}.${r.doi ? ` doi: ${r.doi}.` : link ? ` ${link}` : ''}`
    }
    if (style === 'chicago') {
      const authors = r.authors.map((a, i) => i === 0 ? `${md(a.family)}${a.given ? `, ${md(a.given)}` : ''}` : `${md(a.given ?? '')} ${md(a.family)}`.trim())
      return `${list(authors, 'and') || title}. ${year}. ${authors.length ? (container ? `“${title}.”` : `*${title}*.`) : ''} ${container ? `*${container}*${r.volume ? ` ${r.volume}` : ''}${r.issue ? ` (${r.issue})` : ''}${pages ? `: ${pages}` : ''}.` : r.publisher ? `${md(r.publisher)}.` : ''}${link ? ` ${link}.` : ''}`.replaceAll(/ +/g, ' ').trim()
    }
    return `${list(names, 'and') || title} (${year}) ${names.length ? (container ? `‘${title}’, ` : `*${title}*. `) : ''}${container ? `*${container}*${r.volume ? `, ${r.volume}` : ''}${r.issue ? `(${r.issue})` : ''}${pages ? `, pp. ${pages}` : ''}.` : r.publisher ? `${md(r.publisher)}.` : ''}${link ? ` Available at: ${link}.` : ''}`.replaceAll(/ +/g, ' ').trim()
  })
  return { markdown: entries.join('\n\n') + '\n', keys }
}
export async function citeDocument(input: DocumentInput, io: DocumentIO): Promise<DocumentProduct> {
  if (input.output && !['.md', '.html', '.docx'].includes(extname(input.output).toLowerCase())) throw new Error('cite output must be md, html or docx')
  const references = [...(input.references ?? []), ...(input.bibtex ? parseBibtex(input.bibtex) : []), ...(input.dois?.length ? await resolveDois(input.dois, io.signal) : [])]
  if (!references.length) throw new Error('cite requires references, bibtex or dois')
  documentSchema.parse({ op: 'cite', references })
  const style = input.style ?? 'apa'
  const formatted = formatReferences(references, style)
  const detail = { ...formatted, style, source: CITATION_SOURCES[style], scope: CITATION_SCOPE, ...(input.dois?.length ? { crossref: CROSSREF_TERMS } : {}) }
  if (!input.output) return { files: [], road: 'local bibliography', detail }
  const product = await createDocument({ op: 'create', output: input.output, markdown: formatted.markdown, metadata: input.metadata }, io)
  return { ...product, road: `local bibliography to ${product.road}`, detail }
}
