import type { Node } from '../../../bash/parser.js'
import { layersOf, programOf } from './layers.js'
import { POSIX_SHELLS, ansiC, buriedScripts, nestedScripts, printedBy, readsStdin } from './scripts.js'
import { UNREAD_PART, type ReadRedirect } from './reading.js'
import type { Frame, Reading } from './total.js'
import { keepWordsAsWritten } from './written.js'
import { notBuilt } from '../../../../pi/holes.js'

const PASSTHROUGH = new Set(['cat', 'tee'])

export const READING_CAP = 8

function unescapeBackslashes(text: string): string {
  return text.replace(/\\([\s\S])/g, (_all, ch: string) => (ch === '\n' ? '' : ch))
}

type Words = { values: string[]; inner: number[] }

const WORD_KINDS = new Set(['word', 'number', 'raw_string', 'string', 'concatenation', 'ansi_c_string', 'translated_string', 'simple_expansion', 'expansion', 'command_substitution', 'process_substitution', 'arithmetic_expansion', 'brace_expression'])
const WRITE_KEEPERS = new Set(['file_redirect', 'heredoc_redirect', 'herestring_redirect'])
const COVERED_IN_EXPANSION = new Set(['command_substitution', 'process_substitution', 'regex', 'string', 'translated_string', 'expansion'])
const BRACE_CAP = 64

type ExpandedWord = { values: string[]; written: string; inner: number[] }
type BraceToken = { kind: 'open' | 'comma' | 'close' } | { kind: 'atom'; word: ExpandedWord }

function joinExpanded(left: ExpandedWord[], right: ExpandedWord[]): ExpandedWord[] | undefined {
  const out: ExpandedWord[] = []
  for (const a of left) {
    for (const b of right) {
      if (out.length >= BRACE_CAP) return undefined
      out.push({ values: cross(a.values, b.values), written: a.written + b.written, inner: [...a.inner, ...b.inner] })
    }
  }
  return out
}

function expandBraceTokens(tokens: readonly BraceToken[]): ExpandedWord[] | undefined {
  const empty: ExpandedWord = { values: [''], written: '', inner: [] }
  const parseSeq = (from: number, stopAt: 'end' | 'brace'): { words: ExpandedWord[] | undefined; next: number } => {
    let acc: ExpandedWord[] | undefined = [empty]
    let i = from
    while (i < tokens.length) {
      const tok = tokens[i]!
      if (stopAt === 'brace' && (tok.kind === 'comma' || tok.kind === 'close')) break
      if (tok.kind === 'atom') {
        if (acc !== undefined) acc = joinExpanded(acc, [tok.word])
        i++
      } else if (tok.kind === 'open') {
        const group = parseBrace(i)
        if (group !== undefined) {
          if (acc !== undefined) acc = group.words === undefined ? undefined : joinExpanded(acc, group.words)
          i = group.next
        } else {
          if (acc !== undefined) acc = joinExpanded(acc, [{ values: ['{'], written: '{', inner: [] }])
          i++
        }
      } else {
        const ch = tok.kind === 'comma' ? ',' : '}'
        if (acc !== undefined) acc = joinExpanded(acc, [{ values: [ch], written: ch, inner: [] }])
        i++
      }
    }
    return { words: acc, next: i }
  }
  const parseBrace = (openAt: number): { words: ExpandedWord[] | undefined; next: number } | undefined => {
    const alts: Array<ExpandedWord[] | undefined> = []
    let i = openAt + 1
    let commas = 0
    while (i < tokens.length) {
      const part = parseSeq(i, 'brace')
      alts.push(part.words)
      i = part.next
      if (i >= tokens.length) return undefined
      if (tokens[i]!.kind === 'comma') {
        commas++
        i++
      } else if (tokens[i]!.kind === 'close') {
        if (commas === 0) return undefined
        const out: ExpandedWord[] = []
        for (const alt of alts) {
          if (alt === undefined) return { words: undefined, next: i + 1 }
          for (const w of alt) {
            if (out.length >= BRACE_CAP) return { words: undefined, next: i + 1 }
            out.push(w)
          }
        }
        return { words: out, next: i + 1 }
      }
    }
    return undefined
  }
  return parseSeq(0, 'end').words
}

function hasBraceListCandidate(node: Node): boolean {
  let open = false
  let comma = false
  let close = false
  for (const child of node.children) {
    if (child.type !== 'word') continue
    const text = child.text
    for (let i = 0; i < text.length; i++) {
      const ch = text[i]!
      if (ch === '\\') { i++; continue }
      if (ch === '{') open = true
      else if (ch === ',') comma = true
      else if (ch === '}') close = true
    }
  }
  return open && comma && close
}

function cross(left: string[], right: string[]): string[] {
  const out: string[] = []
  for (const a of left) for (const b of right) if (out.length < READING_CAP) out.push(a + b)
  return out
}

export class PosixWalk {
  readonly late = new Map<Node, () => void>()
  inDoubleQuotes = 0

  constructor(
    readonly reading: Reading,
    readonly source: string,
  ) {}

  lineOf(node: Node, frame: Frame): number {
    let line = frame.line
    for (let i = 0; i < node.startIndex && i < this.source.length; i++) if (this.source[i] === '\n') line++
    return line
  }

  children(parent: Node, frame: Frame): void {
    for (let i = 0; i < parent.children.length; i++) {
      const child = parent.children[i]!
      const background = parent.children[i + 1]?.type === '&'
      this.node(child, background && !frame.background ? { ...frame, background: true } : frame)
    }
  }

  isolated(run: () => void): void {
    const cwd = this.reading.cwd
    const oldpwd = this.reading.oldpwd
    const depth = this.reading.folders.length
    run()
    this.reading.cwd = cwd
    this.reading.oldpwd = oldpwd
    this.reading.folders.length = depth
  }

  maybe(frame: Frame): Frame {
    return { ...frame, maybes: [...(frame.maybes ?? []), ++this.reading.contexts] }
  }

  buried(node: Node, frame: Frame, quoted: boolean, text = node.text): number[] {
    const scripts = buriedScripts(text, quoted)
    if (scripts.length === 0) return []
    const at = this.reading.push({ argv: [], env: [], redirects: [], text: node.text, line: this.lineOf(node, frame), cwd: this.reading.cwd, background: frame.background, stages: frame.stages, input: undefined, inner: [], inputInner: [], body: frame.body, dialect: frame.dialect, around: frame.around, gates: frame.gates, maybes: frame.maybes, substituted: true })
    for (const script of scripts) this.reading.pending.push({ text: script, dialect: 'posix', from: at })
    return [at]
  }

  node(node: Node, frame: Frame): void {
    const late = this.late.get(node)
    if (late !== undefined) {
      this.late.delete(node)
      late()
    }
    return posixNode.call(this, node, frame)
  }

  assignment(node: Node, frame: Frame): { name: string; values: string[] } | undefined {
    return notBuilt('src/utils/permissions/decision/commandAnalysis/totalPosix.ts:178')
  }

  loop(node: Node, frame: Frame): void {
    return notBuilt('src/utils/permissions/decision/commandAnalysis/totalPosix.ts:187')
  }

  userPrintedBy(inner: number[]): string | undefined {
    return notBuilt('src/utils/permissions/decision/commandAnalysis/totalPosix.ts:198')
  }

  variable(node: Node, frame: Frame): Words {
    return posixVariable.call(this, node, frame)
  }

  word(node: Node, frame: Frame): Words {
    return posixWord.call(this, node, frame)
  }

  expandWord(node: Node, frame: Frame): ExpandedWord[] {
    return posixExpandWord.call(this, node, frame)
  }

  redirect(node: Node, frame: Frame, redirects: ReadRedirect[], inputInner: number[]): void {
    let op = ''
    for (const child of node.children) {
      if (child.type === 'file_descriptor') continue
      if (op === '') {
        op = child.type
        continue
      }
      const read = this.word(child, frame)
      if (child.type === 'process_substitution') {
        if (op === '<') inputInner.push(...read.inner)
        continue
      }
      for (const target of read.values) redirects.push({ op, target })
    }
  }

  command(node: Node, frame: Frame, redirects: ReadRedirect[], input: string | undefined, inputInner: number[]): number {
    return notBuilt('src/utils/permissions/decision/commandAnalysis/totalPosix.ts:240')
  }

  redirected(node: Node, outer: Frame): void {
    return notBuilt('src/utils/permissions/decision/commandAnalysis/totalPosix.ts:308')
  }

  pipeline(node: Node, outer: Frame): void {
    return notBuilt('src/utils/permissions/decision/commandAnalysis/totalPosix.ts:374')
  }

  feed(pipeline: number, size: number): void {
    for (let stage = 1; stage < size; stage++) {
      const at = this.reading.stageHeads.get(`${pipeline}:${stage}`)
      const reader = at === undefined ? undefined : this.reading.commands[at]
      if (at === undefined || reader === undefined || reader.input !== undefined) continue
      if (!layersOf(reader.argv).some(layer => POSIX_SHELLS.has(layer.program) && readsStdin(layer.argv))) continue
      for (let earlier = stage - 1; earlier >= 0; earlier--) {
        const head = this.reading.stageHeads.get(`${pipeline}:${earlier}`)
        const writer = head === undefined ? undefined : this.reading.commands[head]
        const layer = writer === undefined ? undefined : layersOf(writer.argv).at(-1)
        if (writer === undefined || layer === undefined) break
        if (PASSTHROUGH.has(layer.program) && writer.input !== undefined) {
          this.reading.pending.push({ text: writer.input, dialect: 'posix', from: at })
          break
        }
        const printed = printedBy(writer)
        if (printed !== undefined) {
          this.reading.pending.push({ text: printed, dialect: 'posix', from: at })
          break
        }
        if (!PASSTHROUGH.has(layer.program)) break
      }
    }
  }
}

function posixNode(this: PosixWalk, node: Node, frame: Frame): void {
  return notBuilt('src/utils/permissions/decision/commandAnalysis/totalPosix.ts:408')
}

function posixWord(this: PosixWalk, node: Node, frame: Frame): Words {
  return notBuilt('src/utils/permissions/decision/commandAnalysis/totalPosix.ts:502')
}

function posixVariable(this: PosixWalk, node: Node, frame: Frame): Words {
  return notBuilt('src/utils/permissions/decision/commandAnalysis/totalPosix.ts:575')
}

function posixExpandWord(this: PosixWalk, node: Node, frame: Frame): ExpandedWord[] {
  if (node.type !== 'concatenation' || !hasBraceListCandidate(node)) {
    const part = this.word(node, frame)
    return [{ values: part.values, written: node.text, inner: part.inner }]
  }
  const tokens: BraceToken[] = []
  let fallbackValues = ['']
  const fallbackInner: number[] = []
  const stands = this.reading.cwd
  for (const child of node.children) {
    if (child.type !== 'word') {
      const part = this.word(child, frame)
      fallbackValues = cross(fallbackValues, part.values)
      fallbackInner.push(...part.inner)
      tokens.push({ kind: 'atom', word: { values: part.values, written: child.text, inner: part.inner } })
      continue
    }
    const raw = child.text
    const leads = child.startIndex === 0 || /[\s;&|(=:]/.test(this.source[child.startIndex - 1] ?? '')
    const plain = unescapeBackslashes(raw)
    const expandedLead = stands !== undefined && leads && /^~\+(?=\/|$)/.test(raw)
    fallbackValues = cross(fallbackValues, [expandedLead ? stands + plain.slice(2) : plain])
    let valBuf = ''
    let rawBuf = ''
    const flush = (): void => {
      if (valBuf === '' && rawBuf === '') return
      tokens.push({ kind: 'atom', word: { values: [valBuf], written: rawBuf, inner: [] } })
      valBuf = ''
      rawBuf = ''
    }
    let start = 0
    if (expandedLead) {
      valBuf = stands
      rawBuf = '~+'
      start = 2
    }
    for (let i = start; i < raw.length; i++) {
      const ch = raw[i]!
      if (ch === '\\' && i + 1 < raw.length) {
        const next = raw[i + 1]!
        if (next !== '\n') valBuf += next
        rawBuf += '\\' + next
        i++
      } else if (ch === '{') {
        flush()
        tokens.push({ kind: 'open' })
      } else if (ch === ',') {
        flush()
        tokens.push({ kind: 'comma' })
      } else if (ch === '}') {
        flush()
        tokens.push({ kind: 'close' })
      } else {
        valBuf += ch
        rawBuf += ch
      }
    }
    flush()
  }
  const expanded = expandBraceTokens(tokens)
  return expanded !== undefined && expanded.length > 1 ? expanded : [{ values: fallbackValues, written: node.text, inner: fallbackInner }]
}
