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

function cross(left: string[], right: string[]): string[] {
  const out: string[] = []
  for (const a of left) for (const b of right) if (out.length < READING_CAP) out.push(a + b)
  return out
}

export class PosixWalk {
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

  buried(node: Node, frame: Frame, quoted: boolean): number[] {
    const scripts = buriedScripts(node.text, quoted)
    if (scripts.length === 0) return []
    const at = this.reading.push({ argv: [], env: [], redirects: [], text: node.text, line: this.lineOf(node, frame), cwd: this.reading.cwd, background: frame.background, stages: frame.stages, input: undefined, inner: [], inputInner: [], body: frame.body, dialect: frame.dialect, around: frame.around, gates: frame.gates, maybes: frame.maybes, substituted: true })
    for (const text of scripts) this.reading.pending.push({ text, dialect: 'posix', from: at })
    return [at]
  }

  node(node: Node, frame: Frame): void {
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
      } else if (WORD_KINDS.has(child.type)) items.push(...this.word(child, frame).values)
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
    const known = name === undefined ? undefined : this.reading.scope.get(name)
    if (known !== undefined && known.length > 0) return { values: [...known].reverse(), inner }
    if (name === 'PWD' && this.reading.cwd !== undefined && (node.type === 'simple_expansion' || node.text === '${PWD}')) return { values: [this.reading.cwd], inner }
    if (name === 'OLDPWD' && this.reading.oldpwd !== undefined && (node.type === 'simple_expansion' || node.text === '${OLDPWD}')) return { values: [this.reading.oldpwd], inner }
    return { values: [node.text], inner }
  }

  word(node: Node, frame: Frame): Words {
    return posixWord.call(this, node, frame)
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
        case 'command_name':
          words.push(this.word(child.children[0] ?? child, frame))
          written.push((child.children[0] ?? child).text)
          break
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
            words.push(this.word(child, frame))
            written.push(child.text)
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
    for (const child of node.children) {
      if (child.type === 'file_redirect') this.redirect(child, frame, redirects, inputInner)
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
          } else if (part.type === 'file_redirect') this.redirect(part, frame, redirects, inputInner)
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
      this.node(body, inside)
      const last = this.reading.commands[this.reading.commands.length - 1]
      if (last !== undefined && this.reading.commands.length > before) {
        last.redirects = [...last.redirects, ...redirects]
        last.input ??= input
        last.inputInner = [...last.inputInner, ...inputInner]
        this.reading.pending.push(...nestedScripts(last, this.reading.commands.length - 1, this.reading.commands).filter(script => script.text === input))
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
      const body = node.children.find(child => child.type === 'compound_statement' || child.type === 'subshell')?.text
      if (name !== undefined && body !== undefined) this.reading.functions.set(name, body)
      this.isolated(() => this.children(node, { ...frame, body: name ?? frame.body, background: false, stages: [] }))
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
      this.node(node, frame)
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
