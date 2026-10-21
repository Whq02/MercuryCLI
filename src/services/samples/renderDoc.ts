import {
  SAMPLE_CELL_TONES,
  SAMPLE_CHECK_STATES,
  SAMPLE_LINE_TONES,
  SAMPLE_PART_KINDS,
  SAMPLE_TONES,
  SAMPLE_VERDICT_STATUSES,
  type SampleCardV1,
  type SampleCardsPartV1,
  type SampleCellTone,
  type SampleCellV1,
  type SampleCheckState,
  type SampleCheckV1,
  type SampleChecklistPartV1,
  type SampleDiffPartV1,
  type SampleDiffSideV1,
  type SampleDocV1,
  type SampleFigurePartV1,
  type SampleLineTone,
  type SampleOptionV1,
  type SamplePartKind,
  type SamplePartV1,
  type SampleQuestionPartV1,
  type SampleSectionPartV1,
  type SampleStepV1,
  type SampleTablePartV1,
  type SampleTermLineV1,
  type SampleTerminalPartV1,
  type SampleVerdictPartV1,
  type SampleVerdictStatus,
} from './contracts.js'
import { DOC_BRAND_MARK, DOC_SCRIPT, DOC_STYLE } from './docTheme.js'

type Raw = Record<string, unknown>

const KIND_ALIASES: Record<string, SamplePartKind> = {
  summary: 'verdict',
  outcome: 'verdict',
  prose: 'section',
  text: 'section',
  metrics: 'cards',
  stats: 'cards',
  grid: 'cards',
  'before-after': 'diff',
  code: 'terminal',
  log: 'terminal',
  diagram: 'figure',
  flow: 'figure',
  image: 'figure',
  checks: 'checklist',
  tasks: 'checklist',
  decision: 'question',
  ask: 'question',
}

const VERDICT_LABELS: Record<SampleVerdictStatus, string> = {
  approved: 'Verdict · Approved',
  'changes-needed': 'Verdict · Changes needed',
  warning: 'Verdict · Warning',
  halted: 'Verdict · Halted',
  info: 'Summary',
}

const CHECK_SIGILS: Record<SampleCheckState, string> = { done: '✓', pending: '○', failed: '×', skipped: '—' }
const CHECK_PREFIX: Record<string, SampleCheckState> = { ' ': 'pending', '!': 'failed', '-': 'skipped', '–': 'skipped', '—': 'skipped' }
const LINE_TONE_CLASS: Record<SampleLineTone, string> = { default: '', dim: ' tone-dim', add: ' tone-add', del: ' tone-del', warn: ' tone-warn-line', accent: ' tone-accent' }

const RESERVED_IDS = new Set(['glyph-field', 'sticky-verdict', 'sticky-stamp', 'sticky-summary', 'sticky-link', 'tabula-root', 'doc-eyebrow', 'theme-toggle', 'doc-title', 'doc-subtitle', 'doc-meta', 'doc-outline'])
const SLUG_RE = /^[a-z][a-z0-9-]{1,63}$/
const WORD_TONE_MAX = 40
const OK_WORDS = /^(pass(ed)?|verified|ok|done)\b/i
const DANGER_WORDS = /^(fail(ed|ure)?|blocker|defect|major|error)\b/i
const WARN_WORDS = /^(warn(ing)?|minor|pending|polish)\b/i
const PATH_CELL = /^[\w@./-]+\.[a-z][a-z0-9]{0,7}(:\d+(:\d+)?)?$/i
const ID_CELL = /^[A-Z]{1,5}-\d{1,5}$/
const BRACKET_PREFIX = /^\[([ xX!✓✔\-–—])\]\s*/
const DATA_IMAGE = /^data:image\/[\w.+-]+[;,]/i
const LCS_CELLS_MAX = 2_250_000

export function normalizeSampleDoc(input: unknown): SampleDocV1 {
  if (typeof input === 'string') {
    return { meta: [], parts: [sectionPart({ prose: input }, 'doc')] }
  }
  if (!isRecord(input)) throw new Error('sample(): doc must be an object { parts: [...] }')
  const doc = input
  const rawParts: unknown = doc.parts ?? doc.blocks ?? []
  if (!Array.isArray(rawParts)) throw new Error('sample(): doc.parts must be an array of blocks')
  const parts: SamplePartV1[] = []
  if (typeof doc.verdict === 'string' && doc.verdict.trim() !== '') {
    parts.push(verdictPart({ summary: doc.verdict }, 'doc.verdict'))
  } else if (isRecord(doc.verdict)) {
    parts.push(verdictPart(doc.verdict, 'doc.verdict'))
  } else if (doc.verdict !== undefined && doc.verdict !== null) {
    throw new Error('sample(): doc.verdict must be text or a verdict block')
  }
  rawParts.forEach((raw, i) => {
    parts.push(partOf(raw, `parts[${i}]`))
  })
  if (parts.length === 0) throw new Error('sample(): doc.parts is empty — give it at least one block')
  const ids = new Set<string>()
  for (const part of parts) {
    if (part.kind === 'verdict' || part.id === undefined) continue
    if (!SLUG_RE.test(part.id) || part.id.startsWith('part-') || RESERVED_IDS.has(part.id) || ids.has(part.id)) delete part.id
    else ids.add(part.id)
  }
  const title = text(doc.title, 'doc.title')
  const subtitle = text(doc.subtitle ?? doc.lede ?? doc.summary, 'doc.subtitle')
  const eyebrow = text(doc.eyebrow ?? doc.kicker, 'doc.eyebrow')
  return {
    ...(title !== undefined ? { title } : {}),
    ...(subtitle !== undefined ? { subtitle } : {}),
    ...(eyebrow !== undefined ? { eyebrow } : {}),
    meta: lines(doc.meta, 'doc.meta', /\n/),
    parts,
  }
}

function partOf(raw: unknown, path: string): SamplePartV1 {
  if (typeof raw === 'string') return sectionPart({ prose: raw }, path)
  if (!isRecord(raw)) throw new Error(`sample(): ${path} must be a block object { kind, ... }`)
  const kind = kindOf(raw, path)
  switch (kind) {
    case 'verdict': return verdictPart(raw, path)
    case 'section': return sectionPart(raw, path)
    case 'cards': return cardsPart(raw, path)
    case 'table': return tablePart(raw, path)
    case 'diff': return diffPart(raw, path)
    case 'terminal': return terminalPart(raw, path)
    case 'figure': return figurePart(raw, path)
    case 'checklist': return checklistPart(raw, path)
    case 'question': return questionPart(raw, path)
  }
}

function kindOf(raw: Raw, path: string): SamplePartKind {
  const given = raw.kind ?? raw.type
  const word = typeof given === 'string' ? given.trim().toLowerCase().replace(/_/g, '-') : ''
  if ((SAMPLE_PART_KINDS as readonly string[]).includes(word)) return word as SamplePartKind
  const alias = KIND_ALIASES[word]
  if (alias !== undefined) return alias
  if (raw.prose !== undefined || raw.text !== undefined || raw.body !== undefined || raw.content !== undefined) return 'section'
  if (raw.rows !== undefined) return 'table'
  if (Array.isArray(raw.items) && raw.items.length > 0 && raw.items.every(item => typeof item === 'string')) return 'checklist'
  const kinds = SAMPLE_PART_KINDS.join(', ')
  if (word === '') throw new Error(`sample(): ${path} has no kind — one of ${kinds}`)
  throw new Error(`sample(): ${path}.kind "${String(given)}" is not one of ${kinds}`)
}

function verdictPart(raw: Raw, path: string): SampleVerdictPartV1 {
  const status = enumOf(raw.status, `${path}.status`, SAMPLE_VERDICT_STATUSES, 'info')
  const summary = text(raw.summary ?? raw.text ?? raw.outcome ?? raw.message, `${path}.summary`)
  if (summary === undefined || summary === '') throw new Error(`sample(): ${path} verdict needs a summary`)
  const label = text(raw.label ?? raw.title ?? raw.stamp, `${path}.label`) ?? VERDICT_LABELS[status]
  const detail = text(raw.detail, `${path}.detail`)
  return { kind: 'verdict', status, label, summary, ...(detail !== undefined ? { detail } : {}) }
}

function sectionPart(raw: Raw, path: string): SampleSectionPartV1 {
  const base = baseOf(raw, path)
  const prose = lines(raw.prose ?? raw.body ?? raw.content ?? raw.text ?? raw.paragraphs, `${path}.prose`, /\n\s*\n/)
  const items = lines(raw.items ?? raw.bullets ?? raw.list, `${path}.items`, /\n/).map(item => item.replace(/^[-•*]\s+/, ''))
  const note = text(raw.note ?? raw.callout ?? raw.aside, `${path}.note`)
  if (base.heading === undefined && prose.length === 0 && items.length === 0 && note === undefined) {
    throw new Error(`sample(): ${path} section has nothing to show — heading, prose, items or note`)
  }
  return { kind: 'section', ...base, prose, items, ...(note !== undefined ? { note } : {}) }
}

function cardsPart(raw: Raw, path: string): SampleCardsPartV1 {
  const base = baseOf(raw, path)
  const rawItems = raw.items ?? raw.cards ?? raw.metrics ?? raw.stats
  if (!Array.isArray(rawItems) || rawItems.length === 0) throw new Error(`sample(): ${path} cards needs items: [{ label, value, body }]`)
  const items: SampleCardV1[] = rawItems.map((item, i): SampleCardV1 => {
    const p = `${path}.items[${i}]`
    const r: Raw = isRecord(item) ? item : { title: item }
    const tone = enumOf(r.tone, `${p}.tone`, SAMPLE_TONES, 'default')
    let label = text(r.label ?? r.caption, `${p}.label`)
    let title = text(r.title ?? r.heading ?? r.name, `${p}.title`)
    if (label === undefined && title !== undefined) {
      label = title
      title = undefined
    }
    const value = text(r.value ?? r.figure ?? r.number, `${p}.value`)
    const body = text(r.body ?? r.text ?? r.detail ?? r.description, `${p}.body`)
    if (label === undefined && value === undefined && body === undefined) throw new Error(`sample(): ${p} needs a label, a value or a body`)
    return {
      ...(label !== undefined ? { label } : {}),
      ...(value !== undefined ? { value } : {}),
      ...(title !== undefined ? { title } : {}),
      ...(body !== undefined ? { body } : {}),
      tone,
    }
  })
  const given = raw.columns ?? raw.cols
  let columns: 2 | 3 | 4
  if (given === undefined || given === null) columns = items.length <= 2 ? 2 : 3
  else {
    const n = Number(given)
    if (n !== 2 && n !== 3 && n !== 4) throw new Error(`sample(): ${path}.columns must be 2, 3 or 4`)
    columns = n
  }
  return { kind: 'cards', ...base, columns, items }
}

function tablePart(raw: Raw, path: string): SampleTablePartV1 {
  const base = baseOf(raw, path)
  const rawRows = raw.rows ?? raw.data
  if (!Array.isArray(rawRows) || rawRows.length === 0) throw new Error(`sample(): ${path} table needs rows`)
  const givenColumns = raw.columns ?? raw.headers ?? raw.header
  let columns = lines(givenColumns, `${path}.columns`, /\n/)
  const first = rawRows[0]
  if (columns.length === 0 && isRecord(first)) columns = Object.keys(first)
  const rows: SampleCellV1[][] = rawRows.map((row, r): SampleCellV1[] => {
    const p = `${path}.rows[${r}]`
    if (Array.isArray(row)) return row.map((cell, c) => cellOf(cell, `${p}[${c}]`))
    if (isRecord(row)) {
      if (columns.length === 0) throw new Error(`sample(): ${p} is an object row but the table has no columns`)
      return columns.map(key => cellOf(row[key], `${p}.${key}`))
    }
    return [cellOf(row, p)]
  })
  if (columns.length > 0) {
    for (const row of rows) while (row.length < columns.length) row.push({ text: '', tone: 'default' })
  }
  const caption = text(raw.caption ?? raw.note, `${path}.caption`)
  return { kind: 'table', ...base, ...(caption !== undefined ? { caption } : {}), columns, rows }
}

function cellOf(cell: unknown, path: string): SampleCellV1 {
  if (isRecord(cell)) {
    const t = text(cell.text ?? cell.value ?? cell.label, `${path}.text`) ?? ''
    const tone = enumOf(cell.tone, `${path}.tone`, SAMPLE_CELL_TONES, 'default')
    return { text: t, tone }
  }
  if (Array.isArray(cell)) throw new Error(`sample(): ${path} must be a cell: text or { text, tone }`)
  const plain = (cell === null || cell === undefined ? '' : String(cell)).replace(BRACKET_PREFIX, '').trim()
  return { text: plain, tone: autoCellTone(plain) }
}

function autoCellTone(plain: string): SampleCellTone {
  if (plain === '') return 'default'
  if (plain.length <= WORD_TONE_MAX) {
    if (OK_WORDS.test(plain)) return 'ok'
    if (DANGER_WORDS.test(plain)) return 'danger'
    if (WARN_WORDS.test(plain)) return 'warn'
  }
  if (PATH_CELL.test(plain) || ID_CELL.test(plain)) return 'mono'
  return 'default'
}

function diffPart(raw: Raw, path: string): SampleDiffPartV1 {
  const base = baseOf(raw, path)
  const before = raw.before ?? raw.old ?? raw.left
  const after = raw.after ?? raw.new ?? raw.right
  if (before === undefined || after === undefined) throw new Error(`sample(): ${path} diff needs before and after`)
  const caption = text(raw.caption ?? raw.note, `${path}.caption`)
  return {
    kind: 'diff',
    ...base,
    ...(caption !== undefined ? { caption } : {}),
    before: diffSide(before, `${path}.before`, 'Before'),
    after: diffSide(after, `${path}.after`, 'After'),
  }
}

function diffSide(raw: unknown, path: string, fallbackLabel: string): SampleDiffSideV1 {
  const r: Raw = isRecord(raw) ? raw : { code: raw }
  const label = text(r.label ?? r.title, `${path}.label`) ?? fallbackLabel
  const meta = text(r.meta ?? r.file ?? r.path, `${path}.meta`)
  const startRaw = r.start ?? r.from ?? r.line
  let start = 1
  if (startRaw !== undefined && startRaw !== null) {
    const n = Number(startRaw)
    if (!Number.isInteger(n) || n < 1) throw new Error(`sample(): ${path}.start must be a whole line number from 1`)
    start = n
  }
  const source = r.code ?? r.prose ?? r.text ?? r.lines ?? r.content
  const list = lines(source, `${path}.code`, /\n/, true)
  return { label, ...(meta !== undefined ? { meta } : {}), start, lines: list.length > 0 ? list : [''] }
}

function terminalPart(raw: Raw, path: string): SampleTerminalPartV1 {
  const base = baseOf(raw, path)
  const title = text(raw.title ?? raw.label, `${path}.title`) ?? 'Terminal'
  const command = text(raw.command ?? raw.cmd, `${path}.command`)
  const source = raw.lines ?? raw.output ?? raw.code ?? raw.text ?? raw.content
  const list: unknown[] = typeof source === 'string' ? splitLines(source, true) : Array.isArray(source) ? source : source === undefined || source === null ? [] : [source]
  const termLines: SampleTermLineV1[] = list.map((line, i): SampleTermLineV1 => {
    const p = `${path}.lines[${i}]`
    if (isRecord(line)) {
      const t = text(line.text ?? line.line ?? line.value, `${p}.text`) ?? ''
      return { text: t, tone: enumOf(line.tone, `${p}.tone`, SAMPLE_LINE_TONES, 'default') }
    }
    if (Array.isArray(line)) throw new Error(`sample(): ${p} must be a line: text or { text, tone }`)
    const t = line === null || line === undefined ? '' : String(line)
    return { text: t, tone: autoLineTone(t) }
  })
  if (termLines.length === 0 && command === undefined) throw new Error(`sample(): ${path} terminal needs lines (or a command)`)
  const caption = text(raw.caption ?? raw.note, `${path}.caption`)
  return {
    kind: 'terminal',
    ...base,
    title,
    ...(command !== undefined ? { command } : {}),
    lines: termLines,
    ...(caption !== undefined ? { caption } : {}),
  }
}

function autoLineTone(line: string): SampleLineTone {
  const t = line.trimStart()
  if (/^(\[PASS\]|✓|✔|\+ )/.test(t)) return 'add'
  if (/^(\[FAIL\]|×|✗|✘|- |ERROR\b)/.test(t)) return 'del'
  if (/^(#|RUN |>>>|──)/.test(t)) return 'dim'
  if (/^(WARN\b|\u274C)/.test(t) || /^\d+ passed · [1-9]\d* failed/.test(t)) return 'warn'
  return 'default'
}

function figurePart(raw: Raw, path: string): SampleFigurePartV1 {
  const base = baseOf(raw, path)
  const rawSteps = raw.steps ?? raw.nodes ?? raw.flow
  const steps: SampleStepV1[] = []
  if (rawSteps !== undefined && rawSteps !== null) {
    if (!Array.isArray(rawSteps)) throw new Error(`sample(): ${path}.steps must be a list of steps`)
    rawSteps.forEach((step, i) => {
      const p = `${path}.steps[${i}]`
      const r: Raw = isRecord(step) ? step : { label: step }
      const label = text(r.label ?? r.title ?? r.name, `${p}.label`)
      if (label === undefined || label === '') throw new Error(`sample(): ${p} needs a label`)
      const given = text(r.text, `${p}.text`)
      const detail = text(r.detail ?? r.description, `${p}.detail`)
      const meta = text(r.meta ?? r.code, `${p}.meta`)
      const flowText = given ?? detail
      const flowDetail = meta ?? (given !== undefined ? detail : undefined)
      steps.push({ label, ...(flowText !== undefined ? { text: flowText } : {}), ...(flowDetail !== undefined ? { detail: flowDetail } : {}) })
    })
  }
  let svg: string | undefined
  if (raw.svg !== undefined && raw.svg !== null) {
    if (typeof raw.svg !== 'string' || !/^\s*<svg[\s>]/i.test(raw.svg) || !/<\/svg>\s*$/i.test(raw.svg)) {
      throw new Error(`sample(): ${path}.svg must be an inline <svg>…</svg>`)
    }
    svg = sanitizeSvg(raw.svg.trim())
  }
  let src: string | undefined
  if (typeof raw.src === 'string' && DATA_IMAGE.test(raw.src.trim())) src = raw.src.trim()
  if (steps.length === 0 && svg === undefined && src === undefined) {
    throw new Error(`sample(): ${path} figure needs steps, an inline svg or a data:image src (remote urls are dropped)`)
  }
  const caption = text(raw.caption ?? raw.note, `${path}.caption`)
  const alt = text(raw.alt, `${path}.alt`) ?? base.heading ?? (steps.length > 0 ? steps.map(s => s.label).join(' → ') : 'Figure')
  return {
    kind: 'figure',
    ...base,
    steps,
    ...(svg !== undefined ? { svg } : {}),
    ...(src !== undefined ? { src } : {}),
    alt,
    ...(caption !== undefined ? { caption } : {}),
  }
}

function checklistPart(raw: Raw, path: string): SampleChecklistPartV1 {
  const base = baseOf(raw, path)
  const rawItems = raw.items ?? raw.checks ?? raw.tasks
  if (!Array.isArray(rawItems) || rawItems.length === 0) throw new Error(`sample(): ${path} checklist needs items`)
  const items: SampleCheckV1[] = rawItems.map((item, i): SampleCheckV1 => {
    const p = `${path}.items[${i}]`
    if (isRecord(item)) {
      const t = text(item.text ?? item.label ?? item.title, `${p}.text`)
      if (t === undefined || t === '') throw new Error(`sample(): ${p} needs text`)
      const detail = text(item.detail ?? item.note, `${p}.detail`)
      let state = enumOf(item.state ?? item.status, `${p}.state`, SAMPLE_CHECK_STATES, 'done')
      if (item.state === undefined && item.status === undefined && typeof item.done === 'boolean') state = item.done ? 'done' : 'pending'
      return { text: t, state, ...(detail !== undefined ? { detail } : {}) }
    }
    if (Array.isArray(item)) throw new Error(`sample(): ${p} must be an item: text or { text, state, detail }`)
    const s = item === null || item === undefined ? '' : String(item)
    const m = BRACKET_PREFIX.exec(s)
    const state: SampleCheckState = m ? (CHECK_PREFIX[m[1] as string] ?? 'done') : 'done'
    const t = s.replace(BRACKET_PREFIX, '').trim()
    if (t === '') throw new Error(`sample(): ${p} needs text`)
    return { text: t, state }
  })
  return { kind: 'checklist', ...base, items }
}

function questionPart(raw: Raw, path: string): SampleQuestionPartV1 {
  const heading = text(raw.heading ?? raw.question ?? raw.title, `${path}.heading`)
  if (heading === undefined || heading === '') throw new Error(`sample(): ${path} question needs a heading`)
  const base = baseOf({ ...raw, heading }, path)
  const prompt = text(raw.prompt ?? raw.body ?? raw.detail, `${path}.prompt`)
  const rawOptions = raw.options ?? raw.choices
  if (!Array.isArray(rawOptions) || rawOptions.length === 0) throw new Error(`sample(): ${path} question needs options`)
  const options: SampleOptionV1[] = rawOptions.map((opt, i): SampleOptionV1 => {
    const p = `${path}.options[${i}]`
    const r: Raw = isRecord(opt) ? opt : { label: opt }
    const label = text(r.label ?? r.text ?? r.title, `${p}.label`)
    if (label === undefined || label === '') throw new Error(`sample(): ${p} needs a label`)
    const description = text(r.description ?? r.detail ?? r.body, `${p}.description`)
    return { label, ...(description !== undefined ? { description } : {}), recommended: r.recommended === true }
  })
  return { kind: 'question', ...base, heading, ...(prompt !== undefined ? { prompt } : {}), options }
}

function baseOf(raw: Raw, path: string): { id?: string; heading?: string; numeral?: string } {
  const heading = text(raw.heading ?? raw.title, `${path}.heading`)
  const numeral = raw.numeral === undefined || raw.numeral === null ? undefined : String(raw.numeral).trim()
  const id = typeof raw.id === 'string' ? raw.id.trim() : undefined
  return {
    ...(id !== undefined ? { id } : {}),
    ...(heading !== undefined ? { heading } : {}),
    ...(numeral !== undefined ? { numeral } : {}),
  }
}

function isRecord(v: unknown): v is Raw {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function text(v: unknown, path: string): string | undefined {
  if (v === undefined || v === null) return undefined
  if (typeof v === 'string') {
    const t = v.trim()
    return t === '' ? undefined : t
  }
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (Array.isArray(v)) {
    if (v.every(x => typeof x === 'string' || typeof x === 'number' || typeof x === 'boolean')) return text(v.map(String).join(' '), path)
    throw new Error(`sample(): ${path} must be text`)
  }
  throw new Error(`sample(): ${path} must be text`)
}

function lines(v: unknown, path: string, splitter: RegExp, keepBlank = false): string[] {
  if (v === undefined || v === null) return []
  if (typeof v === 'string') return splitLines(v, keepBlank, splitter)
  if (typeof v === 'number' || typeof v === 'boolean') return [String(v)]
  if (Array.isArray(v)) {
    const out: string[] = []
    v.forEach((item, i) => {
      if (item === null || item === undefined) return
      if (typeof item === 'string') {
        if (keepBlank) out.push(item.replace(/\r$/, ''))
        else {
          const t = item.trim()
          if (t !== '') out.push(t)
        }
        return
      }
      if (typeof item === 'number' || typeof item === 'boolean') {
        out.push(String(item))
        return
      }
      throw new Error(`sample(): ${path}[${i}] must be text`)
    })
    return out
  }
  throw new Error(`sample(): ${path} must be text or a list of text`)
}

function splitLines(s: string, keepBlank: boolean, splitter: RegExp = /\n/): string[] {
  const normalized = s.replace(/\r\n?/g, '\n')
  if (keepBlank) {
    const parts = normalized.split(splitter)
    while (parts.length > 0 && parts[parts.length - 1] === '') parts.pop()
    return parts
  }
  return normalized.split(splitter).map(p => p.trim()).filter(p => p !== '')
}

function enumOf<T extends string>(v: unknown, path: string, allowed: readonly T[], fallback: T): T {
  if (v === undefined || v === null || v === '') return fallback
  const word = String(v).trim().toLowerCase().replace(/_/g, '-')
  if ((allowed as readonly string[]).includes(word)) return word as T
  throw new Error(`sample(): ${path} "${String(v)}" is not one of ${allowed.join(', ')}`)
}

const SVG_ELEMENTS = new Set('svg a animate animateMotion animateTransform circle clipPath defs desc discard ellipse feBlend feColorMatrix feComponentTransfer feComposite feConvolveMatrix feDiffuseLighting feDisplacementMap feDistantLight feDropShadow feFlood feFuncA feFuncB feFuncG feFuncR feGaussianBlur feImage feMerge feMergeNode feMorphology feOffset fePointLight feSpecularLighting feSpotLight feTile feTurbulence filter font font-face font-face-format font-face-name font-face-src font-face-uri g glyph glyphRef hatch hatchpath hkern image line linearGradient marker mask mesh meshgradient meshpatch meshrow metadata missing-glyph mpath path pattern polygon polyline radialGradient rect set solidcolor stop switch symbol text textPath title tref tspan use view vkern'.toLowerCase().split(' '))
const SVG_TOKEN = /<!--[\s\S]*?(?:-->|$)|<!\[CDATA\[[\s\S]*?(?:\]\]>|$)|<(?:[^<>"']|"[^"]*"|'[^']*')*(?:>|$)|</g
const TAG = /^<(\/?)([a-zA-Z][\w.-]*)((?:\s+[\w:.-]+\s*=\s*(?:"[^"<]*"|'[^'<]*'|[^\s"'`=<>/]+))*)\s*(\/?)>$/
const ATTR = /([\w:.-]+)\s*=\s*("[^"]*"|'[^']*'|[^\s"'`=<>/]+)/g

export function sanitizeSvg(svg: string): string {
  return svg.replace(SVG_TOKEN, token => {
    if (token.startsWith('<![CDATA[')) return escapeHtml(token.slice(9).replace(/\]\]>$/, ''))
    const tag = TAG.exec(token)
    if (!tag) return ''
    const end = tag[1]!, name = tag[2]!, attrs = tag[3]!, close = tag[4]!
    if (!SVG_ELEMENTS.has(name.toLowerCase())) return ''
    if (end) return attrs === '' && !close ? `</${name}>` : ''
    const fields = new Map<string, { name: string; value: string }>()
    for (const match of attrs.matchAll(ATTR)) {
      const attr = match[1]!
      const raw = match[2]!
      const value = decodeEntities(raw.startsWith('"') || raw.startsWith("'") ? raw.slice(1, -1) : raw)
      const lower = attr.toLowerCase()
      if (!fields.has(lower)) fields.set(lower, { name: attr, value })
    }
    const animated = fields.get('attributename')?.value.toLowerCase()
    if (animated && (animated.startsWith('on') || animated === 'xml:base' || animated.startsWith('xmlns'))) return ''
    const kept: string[] = []
    for (const [lower, { name: attr, value }] of fields) {
      if (lower.startsWith('on') || lower === 'xml:base') continue
      if (lower === 'xmlns' || lower.startsWith('xmlns:')) {
        if (!['http://www.w3.org/2000/svg', 'http://www.w3.org/1999/xlink'].includes(value)) continue
      } else {
        const values = lower === 'values' ? value.split(';') : [value]
        const reference = /^(?:xlink:)?href$/.test(lower) || (/^(?:from|to|by|values)$/.test(lower) && /^(?:xlink:)?href$/.test(animated ?? ''))
        if (values.some(v => unsafeValue(v) || (reference && !safeSvgReference(v, /^(image|feimage)$/i.test(name))))) continue
      }
      kept.push(`${attr}="${escapeHtml(value)}"`)
    }
    return `<${name}${kept.length > 0 ? ' ' + kept.join(' ') : ''}${close ? ' /' : ''}>`
  })
}

const NAMED_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", colon: ':', sol: '/', newline: '\n', tab: '\t' }

function decodeEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);?/gi, (_m, hex: string) => String.fromCodePoint(Math.min(parseInt(hex, 16), 0x10ffff)))
    .replace(/&#(\d+);?/g, (_m, dec: string) => String.fromCodePoint(Math.min(Number(dec), 0x10ffff)))
    .replace(/&([a-z]+);?/gi, (m, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? m)
}

function safeSvgReference(value: string, image = true): boolean {
  const v = value.trim()
  return v.startsWith('#') || (image && DATA_IMAGE.test(v))
}

function unsafeValue(value: string): boolean {
  const v = decodeEntities(value)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\\([0-9a-f]{1,6})\s?|\\([^\r\n])/gi, (_m, hex: string | undefined, char: string | undefined) => hex ? String.fromCodePoint(Math.min(parseInt(hex, 16), 0x10ffff)) : char ?? '')
    .replace(/[\s\u0000-\u001f]+/g, '').toLowerCase()
  if (/^(javascript|vbscript|livescript):/.test(v)) return true
  if (/^data:(?!image\/)/.test(v)) return true
  if (/^(https?:)?\/\//.test(v)) return true
  for (const match of v.matchAll(/url\(([^)]*)\)/g)) {
    if (!safeSvgReference(match[1]!.replace(/^['"]|['"]$/g, ''))) return true
  }
  if (/@import|expression\(/.test(v)) return true
  return false
}

export function renderSampleDoc(doc: SampleDocV1, opts: { title?: string } = {}): string {
  const title = (opts.title ?? doc.title ?? 'Sample').replace(/\s+/g, ' ').trim() || 'Sample'
  let counted = 0
  const body = doc.parts.map((part, i) => {
    let num: string | undefined
    if (part.kind !== 'verdict' && part.heading !== undefined) {
      if (part.numeral === undefined) num = `${roman(++counted)}.`
      else if (part.numeral !== '') num = part.numeral
    }
    return renderPart(part, i + 1, num)
  })
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="color-scheme" content="dark light">',
    '<meta name="referrer" content="no-referrer">',
    '<link rel="icon" href="data:,">',
    `<title>${escapeHtml(title)} · Mercury</title>`,
    `<style>${DOC_STYLE}</style>`,
    '</head>',
    '<body>',
    '<canvas class="glyph-field" id="glyph-field" aria-hidden="true"></canvas>',
    '<div class="sticky-verdict" id="sticky-verdict" hidden>',
    '  <span class="sticky-stamp" id="sticky-stamp"></span>',
    '  <span class="sticky-summary" id="sticky-summary"></span>',
    '  <a class="sticky-link" id="sticky-link" href="#" hidden>Decision ↓</a>',
    '</div>',
    '<main class="tabula" id="tabula-root">',
    '',
    renderHeader(doc, title),
    '',
    ...body,
    '</main>',
    `<script>${DOC_SCRIPT}</script>`,
    '</body>',
    '</html>',
    '',
  ].join('\n')
}

function renderHeader(doc: SampleDocV1, title: string): string {
  const eyebrow = (doc.eyebrow ?? 'Sample').toUpperCase()
  const out = [
    '  <header class="doc-header" id="part-0-header" data-part="header">',
    '    <div class="doc-header-top">',
    '      <div class="brand-lockup">',
    `        ${DOC_BRAND_MARK}`,
    `        <div class="eyebrow" id="doc-eyebrow">MERCURY <span class="interpunct">·</span> ${escapeHtml(eyebrow)}</div>`,
    '      </div>',
    '      <div class="view-bar">',
    '        <button type="button" class="btn-ghost" id="theme-toggle" aria-pressed="false">Parchment</button>',
    '      </div>',
    '    </div>',
    `    <h1 class="doc-title" id="doc-title">${escapeHtml(title)}</h1>`,
  ]
  if (doc.subtitle !== undefined) out.push(`    <p class="doc-subtitle" id="doc-subtitle">${inline(doc.subtitle)}</p>`)
  if (doc.meta.length > 0) {
    out.push('    <div class="meta-strip" id="doc-meta" aria-label="Document metadata">')
    out.push('      ' + doc.meta.map(item => `<span class="meta-item">${inline(item)}</span>`).join(''))
    out.push('    </div>')
  }
  out.push('    <nav class="doc-outline" id="doc-outline" aria-label="Sections" hidden></nav>')
  out.push('  </header>')
  return out.join('\n')
}

function renderPart(part: SamplePartV1, n: number, numeral: string | undefined): string {
  switch (part.kind) {
    case 'verdict': return renderVerdict(part, n)
    case 'section': return renderSection(part, n, numeral)
    case 'cards': return renderCards(part, n, numeral)
    case 'table': return renderTable(part, n, numeral)
    case 'diff': return renderDiff(part, n, numeral)
    case 'terminal': return renderTerminal(part, n, numeral)
    case 'figure': return renderFigure(part, n, numeral)
    case 'checklist': return renderChecklist(part, n, numeral)
    case 'question': return renderQuestion(part, n, numeral)
  }
}

function open(part: Exclude<SamplePartV1, SampleVerdictPartV1>, n: number, numeral: string | undefined): string {
  const id = part.id ?? `part-${n}-${part.kind}`
  const lines = [`  <section class="part part-${part.kind}" id="${id}" data-part="${part.kind}">`]
  if (part.heading !== undefined) {
    lines.push('    <div class="section-head">')
    if (numeral !== undefined) lines.push(`      <span class="sec-num" aria-hidden="true">${escapeHtml(numeral)}</span>`)
    lines.push(`      <h2 class="section-title" id="part-${n}-heading">${escapeHtml(part.heading)}</h2>`)
    lines.push('    </div>')
  }
  return lines.join('\n')
}

function caption(part: { caption?: string }, n: number): string[] {
  return part.caption !== undefined ? [`    <p class="part-caption" id="part-${n}-caption">${inline(part.caption)}</p>`] : []
}

function renderVerdict(part: SampleVerdictPartV1, n: number): string {
  const aria = part.label.split(' · ')[0] ?? part.label
  const out = [
    `  <section class="part part-verdict status-${part.status}" id="part-${n}-verdict" data-part="verdict" aria-label="${escapeHtml(aria)}">`,
    `    <div class="verdict-stamp" id="part-${n}-stamp">${escapeHtml(part.label)}</div>`,
    `    <p class="verdict-summary" id="part-${n}-summary">${inline(part.summary)}</p>`,
  ]
  if (part.detail !== undefined) out.push(`    <p class="verdict-detail" id="part-${n}-detail">${inline(part.detail)}</p>`)
  out.push('  </section>', '')
  return out.join('\n')
}

function renderSection(part: SampleSectionPartV1, n: number, numeral: string | undefined): string {
  const out = [open(part, n, numeral)]
  if (part.prose.length > 0 || part.items.length > 0 || part.note !== undefined) {
    out.push('    <div class="prose-body">')
    part.prose.forEach((p, i) => out.push(`      <p class="prose-p" id="part-${n}-p-${i + 1}">${inline(p)}</p>`))
    if (part.items.length > 0) {
      out.push(`      <ul class="prose-list" id="part-${n}-list">`)
      part.items.forEach((item, i) => out.push(`        <li class="prose-li" id="part-${n}-li-${i + 1}">${inline(item)}</li>`))
      out.push('      </ul>')
    }
    if (part.note !== undefined) out.push(`      <aside class="prose-note" id="part-${n}-note">${inline(part.note)}</aside>`)
    out.push('    </div>')
  }
  out.push('  </section>', '')
  return out.join('\n')
}

function renderCards(part: SampleCardsPartV1, n: number, numeral: string | undefined): string {
  const out = [open(part, n, numeral), `    <div class="card-grid cols-${part.columns}" id="part-${n}-grid">`]
  part.items.forEach((card, i) => {
    const m = i + 1
    out.push(`      <article class="card${card.tone === 'default' ? '' : ` tone-${card.tone}`}" id="part-${n}-card-${m}">`)
    if (card.label !== undefined) out.push(`        <span class="label">${escapeHtml(card.label)}</span>`)
    if (card.value !== undefined) out.push(`        <div class="card-value" id="part-${n}-value-${m}">${escapeHtml(card.value)}</div>`)
    if (card.title !== undefined) out.push(`        <h3 class="card-title" id="part-${n}-title-${m}">${escapeHtml(card.title)}</h3>`)
    if (card.body !== undefined) out.push(`        <p class="card-body">${inline(card.body)}</p>`)
    out.push('      </article>')
  })
  out.push('    </div>', '  </section>', '')
  return out.join('\n')
}

function renderTable(part: SampleTablePartV1, n: number, numeral: string | undefined): string {
  const out = [open(part, n, numeral), '    <div class="table-wrap">', `      <table class="data-table${part.rows.length > 8 ? ' long' : ''}" id="part-${n}-datatable">`]
  if (part.columns.length > 0) {
    out.push(`        <thead><tr>${part.columns.map(c => `<th scope="col">${escapeHtml(c)}</th>`).join('')}</tr></thead>`)
  }
  out.push('        <tbody>')
  part.rows.forEach((row, r) => {
    const cells = row.map((cell, c) => {
      const cls = cell.tone === 'default' ? 'table-cell' : `table-cell cell-${cell.tone}`
      const body = cell.tone === 'default' ? inline(cell.text) : escapeHtml(cell.text)
      return `<td id="part-${n}-cell-${r + 1}-${c + 1}" class="${cls}">${body}</td>`
    })
    out.push(`          <tr id="part-${n}-row-${r + 1}" class="table-row">${cells.join('')}</tr>`)
  })
  out.push('        </tbody>', '      </table>', '    </div>', ...caption(part, n), '  </section>', '')
  return out.join('\n')
}

function renderDiff(part: SampleDiffPartV1, n: number, numeral: string | undefined): string {
  const { before, after } = diffTones(part.before.lines, part.after.lines)
  const pane = (side: SampleDiffSideV1, which: 'before' | 'after', changed: boolean[]): string[] => {
    const short = which === 'before' ? 'b' : 'a'
    const tone = which === 'before' ? ' tone-del' : ' tone-add'
    const code = side.lines
      .map((line, i) => `<span class="code-line${changed[i] ? tone : ''}" id="part-${n}-${short}-${i + 1}"><span class="line-num">${side.start + i}</span>${escapeHtml(line)}</span>`)
      .join('')
    return [
      `      <div class="diff-pane diff-${which}" id="part-${n}-${which}">`,
      `        <div class="diff-bar"><span class="diff-label">${escapeHtml(side.label)}</span>${side.meta !== undefined ? `<span class="diff-meta">${escapeHtml(side.meta)}</span>` : ''}</div>`,
      `        <pre class="diff-code" id="part-${n}-${which}-pre" tabindex="0">${code}</pre>`,
      '      </div>',
    ]
  }
  const out = [
    open(part, n, numeral),
    '    <div class="diff-tools">',
    ...(part.caption !== undefined ? [`      <p class="part-caption" id="part-${n}-caption">${inline(part.caption)}</p>`] : []),
    '      <div class="diff-actions">',
    `        <button type="button" class="btn-ghost" data-diff-toggle="part-${n}-grid" aria-pressed="false">Unified view</button>`,
    `        <button type="button" class="btn-ghost" data-copy-target="part-${n}-after-pre">Copy after</button>`,
    '      </div>',
    '    </div>',
    `    <div class="diff-grid" id="part-${n}-grid">`,
    ...pane(part.before, 'before', before),
    ...pane(part.after, 'after', after),
    '    </div>',
    '  </section>',
    '',
  ]
  return out.join('\n')
}

export function diffTones(before: string[], after: string[]): { before: boolean[]; after: boolean[] } {
  const n = before.length
  const m = after.length
  const changedBefore = new Array<boolean>(n).fill(true)
  const changedAfter = new Array<boolean>(m).fill(true)
  if (n * m > LCS_CELLS_MAX) {
    for (let i = 0; i < Math.min(n, m); i++) {
      if (before[i] === after[i]) {
        changedBefore[i] = false
        changedAfter[i] = false
      }
    }
    return { before: changedBefore, after: changedAfter }
  }
  const width = m + 1
  const table = new Uint32Array((n + 1) * width)
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i * width + j] = before[i] === after[j] ? (table[(i + 1) * width + j + 1] as number) + 1 : Math.max(table[(i + 1) * width + j] as number, table[i * width + j + 1] as number)
    }
  }
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (before[i] === after[j]) {
      changedBefore[i] = false
      changedAfter[j] = false
      i++
      j++
    } else if ((table[(i + 1) * width + j] as number) >= (table[i * width + j + 1] as number)) i++
    else j++
  }
  return { before: changedBefore, after: changedAfter }
}

function renderTerminal(part: SampleTerminalPartV1, n: number, numeral: string | undefined): string {
  const code = part.lines
    .map((line, i) => `<span class="term-line${LINE_TONE_CLASS[line.tone]}" id="part-${n}-line-${i + 1}"><span class="line-num">${i + 1}</span>${escapeHtml(line.text)}</span>`)
    .join('')
  const out = [
    open(part, n, numeral),
    `    <figure class="term-box" id="part-${n}-termbox">`,
    '      <div class="term-bar">',
    `        <span class="term-title">${escapeHtml(part.title)}</span>`,
    ...(part.command !== undefined ? [`        <span class="term-cmd" id="part-${n}-cmd">${escapeHtml(part.command)}</span>`] : []),
    `        <button type="button" class="btn-ghost" data-copy-target="part-${n}-pre">Copy</button>`,
    '      </div>',
    `      <pre class="term-pre" id="part-${n}-pre" tabindex="0">${code}</pre>`,
    '    </figure>',
    ...caption(part, n),
    '  </section>',
    '',
  ]
  return out.join('\n')
}

function renderFigure(part: SampleFigurePartV1, n: number, numeral: string | undefined): string {
  const out = [open(part, n, numeral)]
  if (part.steps.length > 0) {
    out.push(`    <div class="flow" id="part-${n}-flow" role="list" aria-label="${escapeHtml(part.alt)}">`)
    part.steps.forEach((step, i) => {
      const cells = [`<span class="label">${escapeHtml(step.label)}</span>`]
      if (step.text !== undefined) cells.push(`<span class="flow-text">${escapeHtml(step.text)}</span>`)
      if (step.detail !== undefined) cells.push(`<span class="flow-detail">${escapeHtml(step.detail)}</span>`)
      out.push(`      <div class="flow-step" role="listitem" id="part-${n}-step-${i + 1}">${cells.join('')}</div>`)
    })
    out.push('    </div>')
  }
  if (part.svg !== undefined || part.src !== undefined) {
    out.push(`    <figure class="figure-box" id="part-${n}-figbox">`)
    if (part.svg !== undefined) out.push(`      ${labelledSvg(part.svg, part.alt)}`)
    if (part.src !== undefined) out.push(`      <img src="${escapeHtml(part.src)}" alt="${escapeHtml(part.alt)}">`)
    out.push('    </figure>')
  }
  out.push(...caption(part, n), '  </section>', '')
  return out.join('\n')
}

function labelledSvg(svg: string, alt: string): string {
  return svg.replace(/^<svg\b([^>]*)>/i, (_m, attrs: string) => {
    let a = attrs
    if (!/\srole=/i.test(a)) a += ' role="img"'
    if (!/\saria-label=/i.test(a)) a += ` aria-label="${escapeHtml(alt)}"`
    return `<svg${a}>`
  })
}

function renderChecklist(part: SampleChecklistPartV1, n: number, numeral: string | undefined): string {
  const out = [open(part, n, numeral), `    <ul class="check-list" id="part-${n}-list">`]
  part.items.forEach((item, i) => {
    out.push(`      <li class="check-item state-${item.state}" id="part-${n}-item-${i + 1}">`)
    out.push(`        <span class="check-box" aria-hidden="true">${CHECK_SIGILS[item.state]}</span><span class="sr-only">${item.state}:</span>`)
    const detail = item.detail !== undefined ? `<span class="check-detail">${inline(item.detail)}</span>` : ''
    out.push(`        <div class="check-content"><span class="check-text">${inline(item.text)}</span>${detail}</div>`)
    out.push('      </li>')
  })
  out.push('    </ul>', '  </section>', '')
  return out.join('\n')
}

function renderQuestion(part: SampleQuestionPartV1, n: number, numeral: string | undefined): string {
  const out = [open(part, n, numeral), `    <div class="question-box" id="part-${n}-qbox" data-question="${escapeHtml(part.heading)}">`]
  if (part.prompt !== undefined) out.push(`      <p class="question-prompt" id="part-${n}-qprompt">${inline(part.prompt)}</p>`)
  out.push('      <div class="question-opts" role="group" aria-label="Options">')
  part.options.forEach((opt, i) => {
    out.push(`        <button type="button" class="question-opt" id="part-${n}-opt-${i + 1}" data-opt="${escapeHtml(opt.label)}" aria-pressed="false">`)
    const rec = opt.recommended ? '<span class="opt-rec">Recommended</span>' : ''
    out.push(`          <span class="opt-head"><span class="opt-label">${escapeHtml(opt.label)}</span>${rec}</span>`)
    if (opt.description !== undefined) out.push(`          <span class="opt-desc">${inline(opt.description)}</span>`)
    out.push('        </button>')
  })
  out.push(
    '      </div>',
    '      <div class="question-foot">',
    `        <span class="question-status" id="part-${n}-status" role="status" aria-live="polite">No option chosen yet</span>`,
    `        <button type="button" class="btn-ghost question-copy" id="part-${n}-copy">Copy decision</button>`,
    '      </div>',
    '    </div>',
    '  </section>',
    '',
  )
  return out.join('\n')
}

const ROMAN: Array<[number, string]> = [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']]

export function roman(n: number): string {
  let rest = Math.max(1, Math.min(3999, Math.floor(n)))
  let out = ''
  for (const [value, glyph] of ROMAN) {
    while (rest >= value) {
      out += glyph
      rest -= value
    }
  }
  return out
}

export function inline(text: string): string {
  const parts = text.split('`')
  if (parts.length % 2 === 0) return bold(escapeHtml(text))
  return parts.map((p, i) => (i % 2 === 1 ? (p === '' ? '``' : `<code>${escapeHtml(p)}</code>`) : bold(escapeHtml(p)))).join('')
}

function bold(escaped: string): string {
  return escaped.replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>')
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
