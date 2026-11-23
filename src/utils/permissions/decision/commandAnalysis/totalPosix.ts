import type { Node } from '../../../bash/parser.js'
import { layersOf, programOf } from './layers.js'
import { POSIX_SHELLS, ansiC, buriedScripts, nestedScripts, printedBy, readsStdin } from './scripts.js'
import { UNREAD_PART, type ReadRedirect } from './reading.js'
import type { Frame, Reading } from './total.js'
import { keepWordsAsWritten } from './written.js'

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

function lastOf(list: Node): Node {
  const last = list.children.findLast(child => child.type !== '&&' && child.type !== '||' && child.type !== ';' && child.type !== '&')
  return last === undefined ? list : last.type === 'list' ? lastOf(last) : last
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
    const name = node.children.find(child => child.type === 'variable_name')?.text
    const value = node.children.find(child => child.type !== 'variable_name' && child.type !== '=' && child.type !== '+=')
    const values = value === undefined ? [''] : this.word(value, frame).values
    if (name === undefined) return undefined
    this.reading.assign(name, values)
    return { name, values }
  }

  loop(node: Node, frame: Frame): void {
    const name = node.children.find(child => child.type === 'variable_name')?.text
    const items: string[] = []
    for (const child of node.children) {
      if (child.type === 'do_group') {
        if (name !== undefined) this.reading.scope.set(name, items.length > 0 ? items.slice(0, READING_CAP) : [`$${name}`])
        this.children(child, this.maybe(frame))
      } else if (WORD_KINDS.has(child.type)) for (const item of this.expandWord(child, frame)) items.push(...item.values)
    }
  }

  userPrintedBy(inner: number[]): string | undefined {
    if (inner.length !== 1) return undefined
    const argv = this.reading.commands[inner[0]!]?.argv ?? []
    const program = programOf(argv[0] ?? '')
    const { user, uid } = this.reading.world
    if (program === 'pwd' && argv.slice(1).every(word => /^-[LP]+$/.test(word))) return this.reading.commands[inner[0]!]?.cwd
    if ((program === 'whoami' || program === 'logname') && argv.length === 1) return user
    if (program !== 'id') return undefined
    const flags = argv.slice(1).join('')
    if (flags === '-un' || flags === '-nu' || flags === '-u-n' || flags === '-n-u') return user
    return flags === '-u' || flags === '-ru' || flags === '-ur' ? uid : undefined
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
    const words: Words[] = []
    const written: string[] = []
    const env: Array<{ name: string; value: string }> = []
    const own = [...redirects]
    const ownInner = [...inputInner]
    let text = input
    for (const child of node.children) {
      switch (child.type) {
        case 'variable_assignment': {
          const name = child.children.find(part => part.type === 'variable_name')?.text
          const value = child.children.find(part => part.type !== 'variable_name' && part.type !== '=' && part.type !== '+=')
          if (name !== undefined) env.push({ name, value: value === undefined ? '' : (this.word(value, frame).values[0] ?? '') })
          break
        }
        case 'command_name': {
          const target = child.children[0] ?? child
          for (const item of this.expandWord(target, frame)) {
            words.push({ values: item.values, inner: item.inner })
            written.push(item.written)
          }
          break
        }
        case 'file_redirect':
          this.redirect(child, frame, own, ownInner)
          break
        case 'herestring_redirect': {
          const content = child.children.find(part => part.type !== '<<<' && part.type !== 'file_descriptor')
          if (content !== undefined) text = this.word(content, frame).values[0]
          break
        }
        default:
          if (WORD_KINDS.has(child.type)) {
            for (const item of this.expandWord(child, frame)) {
              words.push({ values: item.values, inner: item.inner })
              written.push(item.written)
            }
          } else this.node(child, frame)
      }
    }
    const readings = Math.min(READING_CAP, Math.max(1, ...words.map(word => word.values.length)))
    let first = -1
    for (let k = 0; k < readings; k++) {
      const index = this.reading.push({
        argv: words.map(word => word.values[Math.min(k, word.values.length - 1)] ?? ''),
        env,
        redirects: own,
        text: node.text,
        line: this.lineOf(node, frame),
        cwd: this.reading.cwd,
        background: frame.background,
        stages: frame.stages,
        input: text,
        inner: words.map(word => word.inner),
        inputInner: ownInner,
        body: frame.body,
        dialect: frame.dialect,
        around: frame.around,
        gates: frame.gates,
        maybes: frame.maybes,
        substituted: frame.substituted,
      })
      keepWordsAsWritten(this.reading.commands[index], written)
      if (first < 0) first = index
    }
    return first
  }

  redirected(node: Node, outer: Frame): void {
    const frame = outer.around === undefined ? { ...outer, around: node.text } : outer
    const redirects: ReadRedirect[] = []
    const inputInner: number[] = []
    let input: string | undefined
    let body: Node | undefined
    const continuations: Node[] = []
    const held: Array<() => void> = []
    const valued = (run: () => void): void => {
      if (body?.type === 'list') held.push(run)
      else run()
    }
    for (const child of node.children) {
      if (child.type === 'file_redirect') valued(() => this.redirect(child, frame, redirects, inputInner))
      else if (child.type === 'herestring_redirect') {
        const content = child.children.find(part => part.type !== '<<<' && part.type !== 'file_descriptor')
        if (content !== undefined) input = this.word(content, frame).values[0]
      } else if (child.type === 'heredoc_redirect') {
        const expands = !/['"\\]/.test(child.children.find(part => part.type === 'heredoc_start')?.text ?? '')
        for (const part of child.children) {
          if (part.type === 'heredoc_body') {
            input = part.text
            this.children(part, frame)
            if (expands) for (const leaf of part.children.length === 0 ? [part] : part.children.filter(piece => piece.type === 'heredoc_content')) this.buried(leaf, frame, false)
          } else if (part.type === 'file_redirect') valued(() => this.redirect(part, frame, redirects, inputInner))
          else if (part.type !== '<<' && part.type !== '<<-' && part.type !== 'heredoc_start' && part.type !== 'heredoc_end' && part.type !== 'file_descriptor') continuations.push(part)
        }
      } else if (!WRITE_KEEPERS.has(child.type) && body === undefined) body = child
      else this.node(child, frame)
    }
    const piped = continuations.find(part => part.type === 'pipeline')
    const pipeline = piped === undefined ? undefined : this.reading.pipelineSizes.push(1 + piped.children.filter(part => part.type !== '|' && part.type !== '|&').length) - 1
    const inside = pipeline === undefined ? frame : { ...frame, stages: [...frame.stages, { pipeline, stage: 0 }] }
    const before = this.reading.commands.length
    if (body === undefined) this.reading.push({ argv: [], env: [], redirects, text: node.text, line: this.lineOf(node, frame), cwd: this.reading.cwd, background: frame.background, stages: inside.stages, input, inner: [], inputInner, body: frame.body, dialect: frame.dialect, around: frame.around })
    else if (body.type === 'command') this.command(body, inside, redirects, input, inputInner)
    else {
      const owner = held.length > 0 ? lastOf(body) : undefined
      if (owner !== undefined) this.late.set(owner, () => held.splice(0).forEach(run => run()))
      this.node(body, inside)
      const at = this.reading.commands.length - 1
      const last = this.reading.commands[at]
      if (owner !== undefined) this.late.delete(owner)
      held.splice(0).forEach(run => run())
      if (last !== undefined && at >= before) {
        last.redirects = [...last.redirects, ...redirects]
        last.input ??= input
        last.inputInner = [...last.inputInner, ...inputInner]
        this.reading.pending.push(...nestedScripts(last, at, this.reading.commands).filter(script => script.text === input))
      } else this.reading.push({ argv: [], env: [], redirects, text: node.text, line: this.lineOf(node, frame), cwd: this.reading.cwd, background: frame.background, stages: inside.stages, input, inner: [], inputInner, body: frame.body, dialect: frame.dialect, around: frame.around })
    }
    for (const part of continuations) {
      if (part !== piped || pipeline === undefined) {
        this.node(part, frame)
        continue
      }
      let stage = 0
      for (const member of part.children) {
        if (member.type === '|' || member.type === '|&') continue
        stage++
        this.isolated(() => this.node(member, { ...frame, stages: [...frame.stages, { pipeline, stage }] }))
      }
      this.feed(pipeline, stage + 1)
    }
  }

  pipeline(node: Node, outer: Frame): void {
    const frame = outer.around === undefined ? { ...outer, around: node.text } : outer
    const members = node.children.filter(child => child.type !== '|' && child.type !== '|&')
    const pipeline = this.reading.pipelineSizes.push(members.length) - 1
    for (const [stage, member] of members.entries()) this.isolated(() => this.node(member, { ...frame, stages: [...frame.stages, { pipeline, stage }] }))
    this.feed(pipeline, members.length)
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
  switch (node.type) {
    case 'command':
      this.command(node, frame, [], undefined, [])
      return
    case 'pipeline':
      this.pipeline(node, frame)
      return
    case 'redirected_statement':
      this.redirected(node, frame)
      return
    case 'subshell':
      this.isolated(() => this.children(node, frame))
      return
    case 'command_substitution':
    case 'process_substitution':
      this.isolated(() => this.children(node, { ...frame, substituted: true }))
      return
    case 'if_statement': {
      let body: Frame | undefined
      node.children.forEach((child, at) => {
        if (child.type === 'then') {
          body = this.maybe(frame)
          return
        }
        const base = child.type === 'elif_clause' || child.type === 'else_clause' ? this.maybe(frame) : (body ?? frame)
        this.node(child, node.children[at + 1]?.type === '&' && !base.background ? { ...base, background: true } : base)
      })
      return
    }
    case 'do_group':
    case 'case_item':
      this.children(node, this.maybe(frame))
      return
    case 'list': {
      const joined = node.children.findIndex(child => child.type === '&&')
      const either = node.children.findIndex(child => child.type === '||')
      if (joined <= 0 && either > 0) {
        for (const child of node.children.slice(0, either)) this.node(child, frame)
        const right = this.maybe(frame)
        for (const child of node.children.slice(either + 1)) this.node(child, right)
        return
      }
      if (joined <= 0) {
        this.children(node, frame)
        return
      }
      const from = this.reading.commands.length
      for (const child of node.children.slice(0, joined)) this.node(child, frame)
      const gate: readonly [number, number] = [from, this.reading.commands.length]
      for (const child of node.children.slice(joined + 1)) this.node(child, { ...frame, gates: [...(frame.gates ?? []), gate] })
      return
    }
    case 'for_statement':
      this.loop(node, frame)
      return
    case 'function_definition': {
      const name = node.children.find(child => child.type === 'word')?.text
      const block = node.children.find(child => child.type === 'compound_statement' || child.type === 'subshell')
      if (name !== undefined && block !== undefined) this.reading.functions.set(name, block.text)
      const from = this.reading.commands.length
      this.isolated(() => this.children(node, { ...frame, body: name ?? frame.body, background: false, stages: [] }))
      if (name !== undefined && block !== undefined) this.reading.define(name, block, this.source, from)
      return
    }
    case 'variable_assignment':
      this.assignment(node, frame)
      return
    case 'regex':
      this.buried(node, frame, true)
      return
    case 'declaration_command':
      for (const child of node.children) {
        if (child.type !== 'variable_assignment') {
          this.node(child, frame)
          continue
        }
        const assigned = this.assignment(child, frame)
        if (assigned !== undefined && node.children[0]?.type === 'export') this.reading.exported.set(assigned.name, assigned.values)
      }
      return
    case 'ERROR':
      this.reading.markUnread('the shell parser found incomplete or invalid syntax in it', this.source)
      this.children(node, frame)
      return
    default:
      if (WORD_KINDS.has(node.type)) {
        this.word(node, frame)
        return
      }
      this.children(node, frame)
  }
}

function posixWord(this: PosixWalk, node: Node, frame: Frame): Words {
  switch (node.type) {
    case 'word': {
      const text = unescapeBackslashes(node.text)
      const stands = this.reading.cwd
      const leads = node.startIndex === 0 || /[\s;&|(=:]/.test(this.source[node.startIndex - 1] ?? '')
      return { values: [stands !== undefined && leads && /^~\+(?=\/|$)/.test(node.text) ? stands + text.slice(2) : text], inner: [] }
    }
    case 'raw_string':
      return { values: [node.text.slice(1, -1)], inner: [] }
    case 'ansi_c_string':
      return { values: [ansiC(node.text.slice(2, -1))], inner: [] }
    case 'simple_expansion':
    case 'expansion':
      return this.variable(node, frame)
    case 'command_substitution':
    case 'process_substitution': {
      const before = this.reading.commands.length
      const saved = this.inDoubleQuotes
      this.inDoubleQuotes = 0
      try {
        this.node(node, frame)
      } finally {
        this.inDoubleQuotes = saved
      }
      const inner: number[] = []
      for (let i = before; i < this.reading.commands.length; i++) inner.push(i)
      const named = node.type === 'command_substitution' ? this.userPrintedBy(inner) : undefined
      return { values: [named ?? UNREAD_PART], inner }
    }
    case 'arithmetic_expansion':
      this.children(node, frame)
      return { values: [UNREAD_PART], inner: [] }
    case 'string':
    case 'translated_string': {
      let values = ['']
      const inner: number[] = []
      let cursor: number | undefined
      this.inDoubleQuotes++
      try {
        for (const child of node.children) {
          if (cursor !== undefined && child.startIndex > cursor) values = cross(values, [this.source.slice(cursor, child.startIndex).replace(/\\([$`"\\\n])/g, (_all, ch: string) => (ch === '\n' ? '' : ch))])
          cursor = child.endIndex
          if (child.type === '"' || child.type === '$"') continue
          if (child.type === 'string_content') {
            values = cross(values, [child.text.replace(/\\([$`"\\\n])/g, (_all, ch: string) => (ch === '\n' ? '' : ch))])
            continue
          }
          const part = WORD_KINDS.has(child.type) ? this.word(child, frame) : { values: [child.text], inner: [] }
          values = cross(values, part.values)
          inner.push(...part.inner)
        }
      } finally {
        this.inDoubleQuotes--
      }
      return { values, inner }
    }
    case 'concatenation': {
      let values = ['']
      const inner: number[] = []
      for (const child of node.children) {
        const part = this.word(child, frame)
        values = cross(values, part.values)
        inner.push(...part.inner)
      }
      return { values, inner }
    }
    default:
      this.children(node, frame)
      return { values: [node.text], inner: [] }
  }
}

function posixVariable(this: PosixWalk, node: Node, frame: Frame): Words {
  const name = (node.children.find(child => child.type === 'variable_name') ?? node.children.find(child => child.type === 'special_variable_name'))?.text
  const inner: number[] = []
  const within = (part: Node): void => {
    for (const child of part.children) {
      if (child.type === 'regex') inner.push(...this.buried(child, frame, true))
      else if (WORD_KINDS.has(child.type)) inner.push(...this.word(child, frame).inner)
      else within(child)
    }
  }
  within(node)
  if (node.type === 'expansion' && (node.text.includes('`') || (this.inDoubleQuotes > 0 && node.text.includes('$(')))) {
    const covered: Array<readonly [number, number]> = []
    const markCovered = (part: Node): void => {
      for (const child of part.children) {
        if (COVERED_IN_EXPANSION.has(child.type) || (child.type === 'raw_string' && this.inDoubleQuotes === 0)) covered.push([child.startIndex, child.endIndex])
        else markCovered(child)
      }
    }
    markCovered(node)
    covered.sort((a, b) => a[0] - b[0])
    let uncovered = ''
    let cursor = node.startIndex
    for (const [start, end] of covered) {
      if (start > cursor) uncovered += this.source.slice(cursor, start)
      if (end > cursor) {
        uncovered += ' '
        cursor = end
      }
    }
    if (node.endIndex > cursor) uncovered += this.source.slice(cursor, node.endIndex)
    inner.push(...this.buried(node, frame, this.inDoubleQuotes === 0, uncovered))
  }
  const known = name === undefined ? undefined : this.reading.scope.get(name)
  if (known !== undefined && known.length > 0) return { values: [...known].reverse(), inner }
  if (name === 'PWD' && this.reading.cwd !== undefined && (node.type === 'simple_expansion' || node.text === '${PWD}')) return { values: [this.reading.cwd], inner }
  const old = this.reading.world.returnsTo ?? this.reading.oldpwd
  if (name === 'OLDPWD' && old !== undefined && (node.type === 'simple_expansion' || node.text === '${OLDPWD}')) return { values: [old], inner }
  return { values: [node.text], inner }
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
