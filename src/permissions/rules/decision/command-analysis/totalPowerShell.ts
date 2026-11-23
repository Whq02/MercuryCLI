import { moveOf, programOf, wordKnown } from './layers.js'
import { UNREAD_PART, type ReadRedirect, type Stage } from './reading.js'
import type { Frame, Reading } from './total.js'
import { keepWordsAsWritten } from './written.js'

type PsTable = ReadonlyArray<readonly [string, string]>
type PsToken = { value: string; text: string; inner: number[]; bare: boolean; other?: string | undefined; table?: PsTable | undefined }
type PsValue = { value: string; sure: boolean }

const PS_STATEMENT_HEAD = new RegExp(`(?:^|${UNREAD_PART})(?:foreach|for|if|elseif|while|switch|until)$`, 'i')
const PS_LOOP_VARIABLE = new RegExp(`^(?:\\[.*\\])?\\$(?:${UNREAD_PART}|[\\p{L}\\p{N}_?^$])`, 'u')

const PS_ASSIGNS = /^([^=]*?)(?:[-+*/%]|\?\?)?=([\s\S]*)$/
const PS_VALUE_START = /^[$[('"@{]/
const PS_OPERATOR = /^(?:[-+*/%,]|\.\.|-(?:[ci]?(?:eq|ne|gt|ge|lt|le|like|notlike|match|notmatch|contains|notcontains|in|notin|replace|split)|f|join|is|isnot|as|and|or|xor|band|bor|bxor|shl|shr))$/i
const PS_HOME_CONSTANT = /^\$(?:home|env:(?:userprofile|home))$/i
const PS_VARIABLE = /^\$(?:(?:script|global|local|private):)?([a-z_]\w*)$/i
const PS_GIVEN = /^\$(?:(?:script|global|local|private):)?([a-z_]\w*)\s*((?:[-+*/%]|\?\?)?=)(?!=)/i
const PS_COMBINE = /^\[(?:System\.)?IO\.Path\]::Combine\(([\s\S]*)\)$/i
const PS_BRACED_NAME = /^\{((?:[a-z_]\w*:)?[a-z_]\w*|\?)\}/i

const PS_MOVES = new Set(['cd', 'chdir', 'sl', 'set-location', 'pushd', 'push-location'])

export class PowerShellWalk {
  at = 0
  typed = false
  said: string | undefined
  maybe: string | undefined
  values = new Map<string, string>()
  tables = new Map<string, PsTable>()
  entries: Array<readonly [string, string]> = []
  parts: readonly PsToken[] = []
  gates: ReadonlyArray<readonly [number, number]> = []
  maybes: readonly number[] = []
  previous: readonly [number, number] | undefined

  constructor(
    readonly reading: Reading,
    readonly source: string,
    readonly frame: Frame,
  ) {}

  line(at: number): number {
    let line = this.frame.line
    for (let i = 0; i < at && i < this.source.length; i++) if (this.source[i] === '\n') line++
    return line
  }

  statements(closer: string | undefined, stages: readonly Stage[]): number[] {
    const made: number[] = []
    const text = this.source
    const outer = { gates: this.gates, maybes: this.maybes, previous: this.previous }
    let held = outer.gates
    let last: readonly [number, number] | undefined
    let said: string | undefined
    let maybe: string | undefined
    let read = 0
    while (this.at < text.length) {
      this.blank(true)
      const ch = text[this.at]
      if (ch === undefined) break
      if (closer !== undefined && ch === closer) break
      if (ch === ')' || ch === '}') {
        this.at++
        continue
      }
      const from = this.reading.commands.length
      this.previous = last
      const own = this.pipeline(closer, stages)
      said = read === 0 ? this.said : undefined
      maybe = read++ === 0 ? this.maybe : undefined
      made.push(...own)
      const moved = own.length === 1 && this.reading.commands.length === from + 1 ? this.plainMove(from) : undefined
      last = moved === undefined ? undefined : [from, from + 1]
      const next = text[this.at]
      if (next === '&' && text[this.at + 1] === '&') {
        this.at += 2
        if (last === undefined) this.maybes = [...this.maybes, ++this.reading.contexts]
        else this.gates = [...this.gates, last]
        continue
      }
      if (moved === 'stops' && last !== undefined) held = [...held, last]
      this.gates = held
      this.maybes = outer.maybes
      if (next === ';' || next === '\n') this.at++
      else if (next === '|' && text[this.at + 1] === '|') this.at += 2
      else if (next === '&') this.at++
    }
    this.gates = outer.gates
    this.maybes = outer.maybes
    this.previous = outer.previous
    this.said = said
    this.maybe = maybe
    return made
  }

  kept(word: PsToken): string | undefined {
    const name = word.bare ? PS_VARIABLE.exec(word.value)?.[1] : undefined
    return name === undefined ? undefined : this.values.get(name.toLowerCase())
  }

  part(word: PsToken, loose = false): PsValue | undefined {
    if (word.value.includes(UNREAD_PART)) return word.other === undefined ? undefined : { value: word.other, sure: false }
    if (!word.bare || PS_HOME_CONSTANT.test(word.value)) return { value: word.value, sure: true }
    const kept = this.kept(word)
    if (kept !== undefined) return { value: kept, sure: false }
    return loose && wordKnown(word.value) && !word.value.startsWith('-') ? { value: word.value, sure: true } : undefined
  }

  literal(words: readonly PsToken[]): PsValue | undefined {
    const head = words[0]
    if (head === undefined) return undefined
    const parts: PsValue[] = []
    const whole = (joint: string): PsValue => ({ value: parts.map((one, at) => (joint === '' ? one.value : at === 0 ? one.value.replace(/[\\/]+$/, '') : one.value.replace(/^[\\/]+/, ''))).join(joint), sure: parts.every(one => one.sure) })
    if (head.bare && /^join-path$/i.test(head.value)) {
      for (const word of words.slice(1)) {
        if (word.bare && /^-(?:path|childpath|additionalchildpath)$/i.test(word.value)) continue
        const one = word.bare && word.value.startsWith('-') ? undefined : this.part(word.text.endsWith(',') ? { ...word, value: word.value.replace(/,$/, '') } : word, true)
        if (one === undefined) return undefined
        parts.push(one)
      }
      return parts.length < 2 ? undefined : whole('\\')
    }
    const combined = words.length === 1 && head.bare ? PS_COMBINE.exec(head.value)?.[1] : undefined
    if (combined !== undefined) {
      for (const piece of combined.match(/'[^']*'|"[^"]*"|[^,]+/g) ?? []) {
        const text = piece.trim()
        if (text === '') continue
        const quoted = /^(['"])([\s\S]*)\1$/.exec(text)
        const one = quoted !== null ? (quoted[2]!.includes('$(') ? undefined : { value: quoted[2]!, sure: true }) : this.part({ value: text, text, inner: [], bare: true })
        if (one === undefined) return undefined
        parts.push(one)
      }
      return parts.length < 2 ? undefined : whole('\\')
    }
    if (words.length >= 3 && !head.bare && words[1]!.bare && /^-f$/i.test(words[1]!.value) && !/\{\d+[,:]/.test(head.value) && !head.value.includes(UNREAD_PART)) {
      for (const word of words.slice(2)) {
        if (word.bare && word.value === ',') continue
        const one = this.part(word.text.endsWith(',') ? { ...word, value: word.value.replace(/,$/, '') } : word)
        if (one === undefined) return undefined
        parts.push(one)
      }
      const sure = parts.every(one => one.sure)
      let missing = false
      const value = head.value.replace(/\{(\d+)\}/g, (_all, at: string) => {
        const one = parts[Number(at)]
        if (one === undefined) missing = true
        return one?.value ?? ''
      })
      return missing ? undefined : { value, sure }
    }
    if (words.length % 2 === 0) return undefined
    for (const [at, word] of words.entries()) {
      if (at % 2 === 1) {
        if (!word.bare || word.value !== '+') return undefined
        continue
      }
      const one = this.part(word)
      if (one === undefined) return undefined
      parts.push(one)
    }
    return whole('')
  }

  plainMove(at: number): 'joined' | 'stops' | undefined {
    const command = this.reading.commands[at]
    const argv = command === undefined || command.background ? [] : command.argv
    const target = argv[1]
    if (target === undefined || !PS_MOVES.has(programOf(argv[0]!)) || target.startsWith('-') || !wordKnown(target)) return undefined
    if (argv.length === 2) return 'joined'
    const stops = argv.length === 4 ? /^-(?:erroraction|ea)$/i.test(argv[2]!) && /^stop$/i.test(argv[3]!) : argv.length === 3 && /^-(?:erroraction|ea):stop$/i.test(argv[2]!)
    return stops && !/\btrap\b/i.test(this.source) ? 'stops' : undefined
  }

  valueOf(words: readonly PsToken[]): readonly PsToken[] {
    let targets = true
    for (const [at, word] of words.entries()) {
      const found = word.bare ? PS_ASSIGNS.exec(word.value) : null
      const parts = found !== null && !found[1]!.includes('(') ? found : null
      const target = word.bare && /^[$[,]/.test(parts === null ? word.value : parts[1]!)
      if (parts === null || parts[1] !== '') {
        if (at > 0 && !(targets && target)) return words
        targets = targets && target
        if (parts === null) continue
      } else if (at === 0 || !(targets || at === 1)) return words
      return this.valueOf(parts[2] === '' ? words.slice(at + 1) : [{ ...word, value: parts[2]!, text: parts[2]! }, ...words.slice(at + 1)])
    }
    return words
  }

  handed(stages: readonly Stage[]): number[] {
    const text = this.source
    const made: number[] = []
    const parts: PsToken[] = []
    const typed = this.typed
    this.typed = this.frame.cmd !== true
    while (this.at < text.length) {
      this.blank(true)
      if (this.at >= text.length || text[this.at] === ')') break
      const part = this.token(stages)
      if (part === undefined) this.at++
      else {
        made.push(...part.inner)
        parts.push(part)
      }
    }
    if (text[this.at] === ')') this.at++
    this.typed = typed
    this.parts = parts
    return made
  }

  asksSuccess(tokens: readonly PsToken[]): boolean {
    const head = tokens[1]
    const asked = tokens.length === 2 && head !== undefined && head.value === UNREAD_PART && head.inner.length === 1 ? this.reading.commands[head.inner[0]!] : undefined
    return asked !== undefined && tokens[0]!.bare && tokens[0]!.value.toLowerCase() === 'if' && asked.argv.length === 1 && asked.argv[0] === '$?'
  }

  blank(lines: boolean): void {
    const text = this.source
    for (;;) {
      const ch = text[this.at]
      if (ch === ' ' || ch === '\t' || ch === '\r' || (lines && ch === '\n')) this.at++
      else if (ch === '`' && (text[this.at + 1] === '\n' || (text[this.at + 1] === '\r' && text[this.at + 2] === '\n'))) this.at += text[this.at + 1] === '\n' ? 2 : 3
      else if (ch === '<' && text[this.at + 1] === '#') {
        const end = text.indexOf('#>', this.at + 2)
        this.at = end < 0 ? text.length : end + 2
      } else if (ch === '#') {
        while (this.at < text.length && text[this.at] !== '\n') this.at++
      } else return
    }
  }

  pipeline(closer: string | undefined, outer: readonly Stage[]): number[] {
    return powerShellPipeline.call(this, closer, outer)
  }

  group(closer: string, stages: readonly Stage[], typed = this.typed): number[] {
    const before = this.reading.commands.length
    const cwd = this.reading.cwd
    const outer = this.typed
    this.typed = typed
    this.statements(closer, stages)
    this.typed = outer
    if (this.source[this.at] === closer) this.at++
    this.reading.cwd = cwd
    const made: number[] = []
    for (let i = before; i < this.reading.commands.length; i++) made.push(i)
    return made
  }

  token(stages: readonly Stage[]): PsToken | undefined {
    return powerShellToken.call(this, stages)
  }
}

function powerShellPipeline(this: PowerShellWalk, closer: string | undefined, outer: readonly Stage[]): number[] {
  const text = this.source
  const made: number[] = []
  const pipeline = this.reading.pipelineSizes.push(1) - 1
  const begun = this.at
  let stage = 0
  let lone: PsValue | undefined
  let given: RegExpExecArray | null = null
  let before: string | undefined
  for (;;) {
    const stages = [...outer, { pipeline, stage }]
    const start = this.at
    const tokens: PsToken[] = []
    const redirects: ReadRedirect[] = []
    for (;;) {
      this.blank(false)
      const ch = text[this.at]
      if (ch === undefined || ch === '\n' || ch === ';' || ch === '|' || (closer !== undefined && ch === closer) || ch === ')' || ch === '}') break
      if (ch === '&' && (text[this.at + 1] === '&' || (tokens.length > 0 && this.valueOf(tokens).length > 0))) break
      const redirect = /^(?:[0-9*]?>>?(?:&[0-9])?)/.exec(text.slice(this.at, this.at + 5))
      if (redirect !== null) {
        this.at += redirect[0].length
        if (redirect[0].includes('&')) continue
        this.blank(false)
        const target = this.token(stages)
        if (target !== undefined) redirects.push({ op: redirect[0].replace(/^[0-9*]/, ''), target: target.value })
        continue
      }
      const kept = this.gates
      if (this.previous !== undefined && this.asksSuccess(tokens)) this.gates = [...kept, this.previous]
      const token = this.token(stages)
      this.gates = kept
      if (token === undefined) break
      tokens.push(token)
    }
    const background = text[this.at] === '&' && text[this.at + 1] !== '&'
    let words = this.valueOf(tokens)
    const assigned = words !== tokens
    if (words === tokens && words.length > 2 && words[0]!.bare && PS_LOOP_VARIABLE.test(words[0]!.value) && words[1]!.bare && words[1]!.value.toLowerCase() === 'in') words = words.slice(2)
    const called = words[0] !== undefined && words[0].bare && (words[0].value === '&' || words[0].value === '.')
    if (called) words = words.slice(1)
    if (stage === 0) {
      lone = called || redirects.length > 0 || background || this.frame.cmd === true ? undefined : this.literal(words)
      given = assigned && this.frame.cmd !== true ? PS_GIVEN.exec(text.slice(start, this.at).trimStart()) : null
      if (assigned && given === null && lone !== undefined && tokens[1]?.bare === true && tokens[1].value === '=') this.entries.push([tokens[0]!.value, lone.value])
    }
    const first = words[0]
    const worded = (this.typed || assigned) && first?.bare === false && (words.length === 1 || first.text.endsWith(',') || (words[1]!.bare && PS_OPERATOR.test(words[1]!.value)))
    const value = this.frame.cmd !== true && !called && (worded || (words.length === 1 && first?.value === UNREAD_PART && first.inner.length === 0))
    const argv: string[] = []
    const inner: number[][] = []
    const second: string[] = []
    const secondInner: number[][] = []
    const written: string[] = []
    const secondWritten: string[] = []
    let varied = false
    for (const [at, word] of (value ? [] : words).entries()) {
      const parts = word.bare && word.value.includes(',') && !word.value.includes(UNREAD_PART) ? word.value.split(',').filter(part => part !== '') : [word.value]
      const swapped = this.frame.cmd !== true && (at > 0 || called) ? (word.other ?? this.kept(word)) : undefined
      const splatted = this.frame.cmd !== true && at > 0 && word.bare ? this.tables.get(/^@([a-z_]\w*)$/i.exec(word.value)?.[1]?.toLowerCase() ?? '') : undefined
      if (swapped !== undefined || splatted !== undefined) varied = true
      for (const part of parts) {
        argv.push(part)
        inner.push(word.inner)
        written.push(parts.length === 1 ? word.text : part)
      }
      for (const part of splatted !== undefined ? splatted.flatMap(([key, held]) => [`-${key}`, held]) : swapped !== undefined ? [swapped] : parts) {
        second.push(part)
        secondInner.push(word.inner)
        secondWritten.push(word.text)
      }
    }
    const readings = varied && moveOf({ argv: second, dialect: 'powershell' }) === undefined ? [argv, second] : [argv]
    if (argv.length > 0 || redirects.length > 0)
      for (const reading of readings) {
        const index = this.reading.push({
          argv: reading,
          env: [],
          redirects,
          text: text.slice(start, this.at).trim(),
          line: this.line(start),
          cwd: this.reading.cwd,
          background: background || this.frame.background,
          stages,
          input: undefined,
          inner: reading === argv ? inner : secondInner,
          inputInner: [],
          body: this.frame.body,
          dialect: 'powershell',
          around: this.frame.around,
          gates: this.gates.length > 0 ? this.gates : undefined,
          maybes: this.maybes.length > 0 ? this.maybes : undefined,
          called: called ? (words[0]?.text.startsWith('{') ? 'block' : 'name') : undefined,
          handed: before,
        })
        made.push(index)
        keepWordsAsWritten(this.reading.commands[index], reading === argv ? written : secondWritten)
      }
    if (stage === 0 && given !== null) {
      const table = given[2] === '=' && words.length === 1 ? words[0]!.table : undefined
      if (table === undefined) this.tables.delete(given[1]!.toLowerCase())
      else this.tables.set(given[1]!.toLowerCase(), table)
    }
    before = this.frame.cmd !== true && !called && redirects.length === 0 && words.length === 1 && first?.bare === false && !first.value.includes(UNREAD_PART) ? first.value : undefined
    if (text[this.at] === '|' && text[this.at + 1] !== '|') {
      this.at++
      stage++
      this.blank(true)
      continue
    }
    break
  }
  this.reading.pipelineSizes[pipeline] = stage + 1
  this.said = stage === 0 && lone?.sure === true ? lone.value : undefined
  this.maybe = stage === 0 && lone?.sure === false ? lone.value : undefined
  if (given !== null) {
    if (stage === 0 && given[2] === '=' && lone !== undefined) this.values.set(given[1]!.toLowerCase(), lone.value)
    else this.values.delete(given[1]!.toLowerCase())
  }
  const whole = text.slice(begun, this.at).trim()
  for (const index of made) {
    const command = this.reading.commands[index]
    if (command !== undefined && command.around === undefined && stage > 0) command.around = whole
  }
  return made
}

function powerShellToken(this: PowerShellWalk, stages: readonly Stage[]): PsToken | undefined {
  const text = this.source
  const start = this.at
  let value = ''
  let bare = true
  const inner: number[] = []
  const swaps: Array<readonly [number, string]> = []
  let table: PsTable | undefined
  while (this.at < text.length) {
    const ch = text[this.at]!
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n' || ch === ';' || ch === '|' || ch === ')' || ch === '}') break
    if (ch === '&') {
      if (this.at === start) value += text[this.at++]
      break
    }
    if (ch === '>' && this.at > start) break
    if ((ch === '@' && (text[this.at + 1] === "'" || text[this.at + 1] === '"')) && text[this.at + 2] === '\n') {
      const quote = text[this.at + 1]!
      const end = text.indexOf(`\n${quote}@`, this.at + 2)
      value += end < 0 ? text.slice(this.at + 3) : text.slice(this.at + 3, end)
      this.at = end < 0 ? text.length : end + 3
      bare = false
      continue
    }
    if (ch === "'") {
      bare = false
      this.at++
      for (; this.at < text.length; this.at++) {
        if (text[this.at] !== "'") value += text[this.at]
        else if (text[this.at + 1] === "'") {
          value += "'"
          this.at++
        } else break
      }
      this.at++
      continue
    }
    if (ch === '"') {
      bare = false
      this.at++
      for (; this.at < text.length; this.at++) {
        const c = text[this.at]!
        if (c === '`' && this.at + 1 < text.length) {
          const escaped = text[++this.at]!
          value += escaped === 'n' ? '\n' : escaped === 't' ? '\t' : escaped === '0' ? '' : escaped
        } else if (c === '"') {
          if (text[this.at + 1] !== '"') break
          value += '"'
          this.at++
        } else if (c === '$' && text[this.at + 1] === '(') {
          this.at += 2
          inner.push(...this.group(')', []))
          this.at--
          value += UNREAD_PART
        } else value += c
      }
      this.at++
      continue
    }
    if (ch === '`' && this.at + 1 < text.length) {
      value += text[this.at + 1] === '\n' ? '' : text[this.at + 1]
      this.at += 2
      continue
    }
    if (ch === '(' && bare && PS_STATEMENT_HEAD.test(value)) break
    if (ch === '(' || ((ch === '$' || ch === '@') && text[this.at + 1] === '(')) {
      if (ch === '(' && value !== '' && /[\w\]]$/.test(value)) {
        if (!PS_VALUE_START.test(text[start]!)) break
        const open = this.at++
        inner.push(...(value.endsWith(']') ? this.group(')', [], this.frame.cmd !== true) : this.handed(stages)))
        const made = /^\[scriptblock\]::create$/i.test(value) && this.parts.length === 1 && !this.parts[0]!.bare && !this.parts[0]!.value.includes(UNREAD_PART) ? this.parts[0]!.value : undefined
        if (made !== undefined && this.frame.cmd !== true) {
          const from = this.reading.push({ argv: [], env: [], redirects: [], text: text.slice(start, this.at), line: this.line(start), cwd: this.reading.cwd, background: this.frame.background, stages, input: undefined, inner: [], inputInner: [], body: this.frame.body, dialect: 'powershell', around: this.frame.around })
          this.reading.pending.push({ text: made, dialect: 'powershell', from })
          inner.push(from)
        }
        value += text.slice(open, this.at)
        continue
      }
      this.at += ch === '(' ? 1 : 2
      inner.push(...this.group(')', [], this.frame.cmd !== true))
      if (this.said === undefined) {
        if (this.maybe !== undefined) swaps.push([value.length, this.maybe])
        value += UNREAD_PART
      } else {
        value += this.said
        bare = false
      }
      continue
    }
    const named = ch === '{' && this.at > start && text[this.at - 1] === '$' && text[this.at - 2] !== '`' ? PS_BRACED_NAME.exec(text.slice(this.at, this.at + 160)) : null
    if (named !== null) {
      this.at += named[0].length
      value += /[\w:]/.test(text[this.at] ?? '') ? named[0] : named[1]
      continue
    }
    if (ch === '{' || (ch === '@' && text[this.at + 1] === '{')) {
      const outer = this.entries
      this.entries = []
      this.at += ch === '{' ? 1 : 2
      inner.push(...this.group('}', stages))
      if (ch === '@' && value === '') table = this.entries
      this.entries = outer
      value += UNREAD_PART
      continue
    }
    value += ch
    this.at++
  }
  if (this.at === start) return undefined
  const other = swaps.length === 0 ? undefined : swaps.reduceRight((whole, [at, literal]) => whole.slice(0, at) + literal + whole.slice(at + 1), value)
  return { value, text: text.slice(start, this.at), inner, bare, other, table: value === UNREAD_PART ? table : undefined }
}
