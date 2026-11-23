import { layersOf, programOf } from './layers.js'
import { UNREAD_PART, type ReadRedirect, type Stage } from './reading.js'
import { POSIX_SHELLS, ansiC, printedBy, readsStdin } from './scripts.js'
import { commentStart, dropHeredocBodies, foldContinuations, lexShellUnit } from './textReader.js'
import type { Frame, Reading } from './total.js'
import { READING_CAP } from './totalPosix.js'
import { keepWordsAsWritten } from './written.js'

const PASSTHROUGH = new Set(['cat', 'tee'])
const MAX_NEST = 64
const ASSIGNMENT_HEAD = /^([A-Za-z_][A-Za-z0-9_]*)(\+?=)/
const DECLARATIONS = new Set(['export', 'declare', 'local', 'readonly', 'typeset'])
const PLAIN_KEYWORDS = new Set(['if', 'elif', 'while', 'until', '!', '{'])
const MAYBE_KEYWORDS = new Set(['then', 'else', 'do'])
const CLOSING_KEYWORDS = new Set(['fi', 'done', 'esac', '}'])
const FUNC_PARENS = /^([A-Za-z_:@./-][A-Za-z0-9_:@./-]*)\s*\(\s*\)\s*/
const FUNC_KEYWORD = /^function\s+([A-Za-z_:@./-][A-Za-z0-9_:@./-]*)(?:\s*\(\s*\))?\s*/
const FOR_HEADER = /^for\s+([A-Za-z_][A-Za-z0-9_]*)\s+in(?:\s+([\s\S]*))?$/
const CASE_HEADER = /^case\s+/
const REDIRECT_START = /^(\d*)(&>>|&>|<<<|<<-|<<|>>|>\||>&|<&|>|<)/
const HEREDOC_OPERATOR = /^<<(-?)\s*(?:'([^']+)'|"([^"]+)"|(\\)?([A-Za-z_][A-Za-z0-9_]*))/
const TRAILING_BACKSLASHES = /\\+$/
const HEREDOC_WORD_BREAK = new Set([' ', '\t', '\r', ';', '|', '&', '(', ')', '<', '>'])
const HEREDOC_SHELL_WORDS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'ash', 'fish', 'eval', 'source', '.', 'su', 'sudo', 'doas'])

type Words = { values: string[]; inner: number[] }
type TokenWord = { values: string[]; inner: number[]; raw: string; quoted: boolean; procSub: boolean }
type ScanBudget = { left: number }
type CaseState = { phase: 'pattern' | 'body'; maybe: number | undefined }
type LoopStage = { stages: readonly Stage[]; around: string | undefined; depth: number }

function heredocShellWord(word: string): boolean {
  const cut = Math.max(word.lastIndexOf('/'), word.lastIndexOf('\\'))
  const name = (cut >= 0 ? word.slice(cut + 1) : word).toLowerCase()
  return HEREDOC_SHELL_WORDS.has(name.endsWith('.exe') ? name.slice(0, -4) : name)
}

function unquotedDroppedHeredocBodies(text: string): Array<{ body: string; line: number }> {
  const lines = text.split('\n')
  const dropped: Array<{ body: string; line: number }> = []
  const bodies: Array<{ terminator: string; dashed: boolean; literal: boolean; commands: boolean; lines: string[]; line: number }> = []
  let quote: '' | "'" | '"' = ''
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]!
    const body = bodies[0]
    if (body !== undefined) {
      while (!body.literal && i + 1 < lines.length && (TRAILING_BACKSLASHES.exec(line)?.[0].length ?? 0) % 2 === 1) line = line.slice(0, -1) + lines[++i]!
      if ((body.dashed ? line.replace(/^\t+/, '') : line) === body.terminator) {
        bodies.shift()
        if (!body.commands && !body.literal && body.lines.length > 0) dropped.push({ body: body.lines.join('\n'), line: body.line })
      } else if (!body.commands && !body.literal) {
        if (body.lines.length === 0) body.line = i + 1
        body.lines.push(line)
      }
      continue
    }
    const opened = bodies.length
    let commands = false
    let word = -1
    const closeWord = (end: number): void => {
      if (word >= 0 && heredocShellWord(line.slice(word, end))) commands = true
      word = -1
    }
    for (let k = 0; k < line.length; k++) {
      const ch = line[k]!
      if (quote === "'") {
        if (ch === "'") quote = ''
      } else if (ch === '\\') {
        if (quote === '' && word < 0) word = k
        k++
      } else if (quote === '"') {
        if (ch === '"') quote = ''
      } else if (ch === "'" || ch === '"') {
        closeWord(k)
        quote = ch
      } else if (commentStart(line, k)) break
      else if (ch === '<' && line[k + 1] === '<') {
        closeWord(k)
        const m = HEREDOC_OPERATOR.exec(line.slice(k))
        if (m === null) k++
        else {
          bodies.push({ terminator: m[2] ?? m[3] ?? m[5] ?? '', dashed: m[1] === '-', literal: m[5] === undefined || m[4] !== undefined, commands: false, lines: [], line: i + 2 })
          k += m[0].length - 1
        }
      } else if (HEREDOC_WORD_BREAK.has(ch)) closeWord(k)
      else if (word < 0) word = k
    }
    closeWord(line.length)
    for (let b = opened; b < bodies.length; b++) bodies[b]!.commands = commands
  }
  for (const body of bodies) {
    if (!body.commands && !body.literal && body.lines.length > 0) dropped.push({ body: body.lines.join('\n'), line: body.line })
  }
  return dropped
}
function cross(left: string[], right: string[]): string[] {
  const out: string[] = []
  for (const a of left) for (const b of right) if (out.length < READING_CAP) out.push(a + b)
  return out
}

function isSpace(ch: string | undefined): boolean {
  return ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n'
}

function skipSpaces(text: string, at: number, end: number): number {
  while (at < end && isSpace(text[at])) at++
  return at
}

function findMatching(text: string, openAt: number, end: number, openCh: string, closeCh: string, budget: ScanBudget): number {
  if (budget.left <= 0) return -1
  let depth = 0
  let quote: '' | "'" | '"' = ''
  let ticks = false
  for (let i = openAt; i < end; i++) {
    if (--budget.left <= 0) return -1
    const ch = text[i]!
    if (quote === "'") {
      if (ch === "'") quote = ''
      continue
    }
    if (quote === '"') {
      if (ch === '\\') i++
      else if (ch === '"') quote = ''
      continue
    }
    if (ch === '\\') {
      i++
      continue
    }
    if (commentStart(text, i)) {
      while (i + 1 < end && text[i + 1] !== '\n') {
        i++
        if (--budget.left <= 0) return -1
      }
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      continue
    }
    if (ch === '`') {
      ticks = !ticks
      continue
    }
    if (ticks) continue
    if (ch === openCh) depth++
    else if (ch === closeCh) {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

function findBacktickEnd(text: string, openAt: number, end: number, inDouble: boolean, budget: ScanBudget): number {
  if (budget.left <= 0) return -1
  for (let i = openAt + 1; i < end; i++) {
    if (--budget.left <= 0) return -1
    const ch = text[i]!
    if (ch === '\\') {
      i++
      continue
    }
    if (ch === '`') return i
    if (!inDouble && (ch === "'" || ch === '"')) {
      const q = ch
      i++
      while (i < end && text[i] !== q) {
        if (--budget.left <= 0) return -1
        if (q === '"' && text[i] === '\\') i++
        i++
      }
    }
  }
  return -1
}

function stripCommentsAndTrim(text: string, start: number, end: number): string {
  let out = ''
  let quote: '' | "'" | '"' = ''
  let depth = 0
  let ticks = false
  for (let i = start; i < end; i++) {
    const ch = text[i]!
    if (quote === "'") {
      if (ch === "'") quote = ''
      out += ch
      continue
    }
    if (quote === '"') {
      if (ch === '\\' && i + 1 < end) {
        out += ch + text[++i]!
        continue
      }
      if (ch === '"') quote = ''
      out += ch
      continue
    }
    if (ch === '\\' && i + 1 < end) {
      out += ch + text[++i]!
      continue
    }
    if (depth === 0 && !ticks && commentStart(text, i)) {
      while (i + 1 < end && text[i + 1] !== '\n') i++
      continue
    }
    if (ch === "'" || ch === '"') quote = ch
    else if (ch === '(') depth++
    else if (ch === ')' && depth > 0) depth--
    else if (ch === '`') ticks = !ticks
    out += ch
  }
  return out.trim()
}

function splitPipelineStages(text: string, start: number, end: number): Array<{ start: number; end: number }> {
  const stages: Array<{ start: number; end: number }> = []
  let stageStart = start
  let quote: '' | "'" | '"' = ''
  let depth = 0
  let braceDepth = 0
  let ticks = false
  for (let i = start; i < end; i++) {
    const ch = text[i]!
    if (quote === "'") {
      if (ch === "'") quote = ''
      continue
    }
    if (quote === '"') {
      if (ch === '\\') i++
      else if (ch === '"') quote = ''
      continue
    }
    if (ch === '\\') {
      i++
      continue
    }
    if (commentStart(text, i)) {
      while (i + 1 < end && text[i + 1] !== '\n') i++
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      continue
    }
    if (ch === '(') {
      depth++
      continue
    }
    if (ch === ')' && depth > 0) {
      depth--
      continue
    }
    if (ch === '{' && (i === start || isSpace(text[i - 1])) && isSpace(text[i + 1])) {
      braceDepth++
      continue
    }
    if (ch === '}' && braceDepth > 0 && (i === start || isSpace(text[i - 1]) || text[i - 1] === ';')) {
      braceDepth--
      continue
    }
    if (ch === '`') {
      ticks = !ticks
      continue
    }
    if (depth === 0 && braceDepth === 0 && !ticks && ch === '|' && text[i + 1] !== '|') {
      stages.push({ start: stageStart, end: i })
      if (text[i + 1] === '&') i++
      stageStart = i + 1
    }
  }
  stages.push({ start: stageStart, end })
  return stages
}

function userPrintedBy(reading: Reading, inner: number[]): string | undefined {
  if (inner.length !== 1) return undefined
  const argv = reading.commands[inner[0]!]?.argv ?? []
  const program = programOf(argv[0] ?? '')
  const { user, uid } = reading.world
  if (program === 'pwd' && argv.slice(1).every(word => /^-[LP]+$/.test(word))) return reading.commands[inner[0]!]?.cwd
  if ((program === 'whoami' || program === 'logname') && argv.length === 1) return user
  if (program !== 'id') return undefined
  const flags = argv.slice(1).join('')
  if (flags === '-un' || flags === '-nu' || flags === '-u-n' || flags === '-n-u') return user
  return flags === '-u' || flags === '-ru' || flags === '-ur' ? uid : undefined
}

function feedPipeline(reading: Reading, pipeline: number, size: number): void {
  for (let stage = 1; stage < size; stage++) {
    const at = reading.stageHeads.get(`${pipeline}:${stage}`)
    const reader = at === undefined ? undefined : reading.commands[at]
    if (at === undefined || reader === undefined || reader.input !== undefined) continue
    if (!layersOf(reader.argv).some(layer => POSIX_SHELLS.has(layer.program) && readsStdin(layer.argv))) continue
    for (let earlier = stage - 1; earlier >= 0; earlier--) {
      const head = reading.stageHeads.get(`${pipeline}:${earlier}`)
      const writer = head === undefined ? undefined : reading.commands[head]
      const layer = writer === undefined ? undefined : layersOf(writer.argv).at(-1)
      if (writer === undefined || layer === undefined) break
      if (PASSTHROUGH.has(layer.program) && writer.input !== undefined) {
        reading.pending.push({ text: writer.input, dialect: 'posix', from: at })
        break
      }
      const printed = printedBy(writer)
      if (printed !== undefined) {
        reading.pending.push({ text: printed, dialect: 'posix', from: at })
        break
      }
      if (!PASSTHROUGH.has(layer.program)) break
    }
  }
}

function scanSimpleVarEnd(text: string, dollarAt: number, end: number): number {
  const next = text[dollarAt + 1]
  if (next === undefined) return dollarAt + 1
  if (/[A-Za-z_]/.test(next)) {
    let i = dollarAt + 2
    while (i < end && /[A-Za-z0-9_]/.test(text[i]!)) i++
    return i
  }
  if (/[?*@$#!0-9-]/.test(next)) return dollarAt + 2
  return dollarAt + 1
}

function stripLeadingCasePattern(text: string, start: number, end: number): number {
  let quote: '' | "'" | '"' = ''
  let parenDepth = 0
  let at = start
  let afterPipe = false
  if (text[at] === '(') at = skipSpaces(text, at + 1, end)
  for (let i = at; i < end; i++) {
    const ch = text[i]!
    if (quote === "'") {
      if (ch === "'") quote = ''
      continue
    }
    if (quote === '"') {
      if (ch === '\\') i++
      else if (ch === '"') quote = ''
      continue
    }
    if (ch === '\\') {
      i++
      afterPipe = false
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      afterPipe = false
      continue
    }
    if (ch === '(') {
      parenDepth++
      afterPipe = false
      continue
    }
    if (ch === ')') {
      if (parenDepth === 0) return i + 1
      parenDepth--
      continue
    }
    if (ch === '|' && parenDepth === 0) {
      afterPipe = true
      continue
    }
    if (isSpace(ch) && parenDepth === 0) {
      const rest = skipSpaces(text, i, end)
      if (afterPipe) {
        i = rest - 1
        continue
      }
      if (text[rest] !== '|' && text[rest] !== ')') return -1
      i = rest - 1
      continue
    }
    afterPipe = false
  }
  return -1
}

function textWalkBlock(this: TextWalk, text: string, frame: Frame): void {
  let at = 0
  let line = frame.line
  let lineAt = 0
  let chainGates = frame.gates
  let chainMaybes = frame.maybes
  const caseStack: CaseState[] = []
  const loopStack: LoopStage[] = []
  const advanceLine = (to: number): number => {
    while (lineAt < to && lineAt < text.length) {
      if (text[lineAt] === '\n') line++
      lineAt++
    }
    return line
  }
  while (at < text.length) {
    const unit = lexShellUnit(text, at, 'posix')
    const lead = skipSpaces(text, unit.start, text.length)
    const fnMatch = lead < text.length ? (FUNC_PARENS.exec(text.slice(lead, Math.min(text.length, lead + 128))) ?? FUNC_KEYWORD.exec(text.slice(lead, Math.min(text.length, lead + 128)))) : null
    if (fnMatch !== null) {
      const bodyAt = lead + fnMatch[0].length
      const open = text[bodyAt]
      if (open === '{' || open === '(') {
        const close = findMatching(text, bodyAt, text.length, open, open === '{' ? '}' : ')', this.budget)
        if (close > bodyAt) {
          const name = fnMatch[1]!
          const bodyText = text.slice(bodyAt, close + 1)
          const inner = text.slice(bodyAt + 1, close)
          const fnLine = advanceLine(lead)
          this.reading.functions.set(name, bodyText)
          const from = this.reading.commands.length
          this.isolated(() => this.walkNested(inner, { ...frame, line: fnLine, body: name, background: false, stages: [], gates: chainGates, maybes: chainMaybes }))
          this.reading.defineText(name, inner, from)
          let nextAt = skipSpaces(text, close + 1, text.length)
          if (text[nextAt] === ';') nextAt++
          at = nextAt
          chainGates = frame.gates
          chainMaybes = frame.maybes
          continue
        }
      }
    }
    const sep = text.slice(unit.end, unit.next)
    const unitLine = advanceLine(skipSpaces(text, unit.start, unit.end))
    const unitFrame: Frame = {
      ...frame,
      line: unitLine,
      background: frame.background || sep === '&',
      gates: chainGates,
      maybes: chainMaybes,
    }
    const before = this.reading.commands.length
    this.walkUnit(text, unit.start, unit.end, unitFrame, caseStack, loopStack)
    if (caseStack.length > 0 && sep === ';' && (text[unit.next] === ';' || text[unit.next] === '&')) {
      let nextAt = unit.next + 1
      if (text[unit.next] === ';' && text[nextAt] === '&') nextAt++
      const top = caseStack[caseStack.length - 1]!
      top.phase = 'pattern'
      top.maybe = undefined
      chainGates = frame.gates
      chainMaybes = frame.maybes
      at = nextAt
      continue
    }
    if (sep === '&&') {
      const gate: readonly [number, number] = [before, this.reading.commands.length]
      chainGates = [...(chainGates ?? []), gate]
    } else if (sep === '||') {
      chainMaybes = [...(chainMaybes ?? []), ++this.reading.contexts]
    } else {
      chainGates = frame.gates
      chainMaybes = frame.maybes
    }
    at = unit.next
  }
}

function textWalkUnit(this: TextWalk, text: string, start: number, end: number, frame: Frame, caseStack: CaseState[], loopStack: LoopStage[]): void {
  let s = skipSpaces(text, start, end)
  while (s < end && commentStart(text, s)) {
    while (s < end && text[s] !== '\n') s++
    s = skipSpaces(text, s, end)
  }
  if (s >= end) return
  let currentFrame = frame
  for (;;) {
    s = skipSpaces(text, s, end)
    if (s >= end) return
    const slice = text.slice(s, Math.min(end, s + 16))
    if (CASE_HEADER.test(slice)) {
      const afterCase = this.skipCaseHeader(text, s, end)
      if (afterCase < 0) return
      caseStack.push({ phase: 'pattern', maybe: undefined })
      s = afterCase
      continue
    }
    const wordEnd = this.plainWordEnd(text, s, end)
    const head = text.slice(s, wordEnd)
    if (head === 'for' && (wordEnd === end || isSpace(text[wordEnd]))) {
      if (loopStack.length > 0) loopStack[loopStack.length - 1]!.depth++
      const rest = stripCommentsAndTrim(text, s, end)
      const forMatch = FOR_HEADER.exec(rest)
      if (forMatch !== null) {
        const name = forMatch[1]!
        const itemSlice = forMatch[2] ?? ''
        const items = this.readListValues(itemSlice, currentFrame)
        this.reading.scope.set(name, items.length > 0 ? items.slice(0, READING_CAP) : [`$${name}`])
        return
      }
      if (/^for\s+\(\(/.test(rest)) return
    }
    if (PLAIN_KEYWORDS.has(head) && (wordEnd === end || isSpace(text[wordEnd]))) {
      if ((head === 'while' || head === 'until') && loopStack.length > 0) loopStack[loopStack.length - 1]!.depth++
      s = wordEnd
      continue
    }
    if (MAYBE_KEYWORDS.has(head) && (wordEnd === end || isSpace(text[wordEnd]))) {
      currentFrame = this.maybe(currentFrame)
      s = wordEnd
      continue
    }
    if (CLOSING_KEYWORDS.has(head) && (wordEnd === end || isSpace(text[wordEnd]))) {
      if (head === 'esac' && caseStack.length > 0) caseStack.pop()
      if (head === 'done' && loopStack.length > 0) {
        const topLoop = loopStack[loopStack.length - 1]!
        if (--topLoop.depth <= 0) loopStack.pop()
      }
      s = wordEnd
      continue
    }
    const topCase = caseStack[caseStack.length - 1]
    if (topCase !== undefined && topCase.phase === 'pattern') {
      const patEnd = stripLeadingCasePattern(text, s, end)
      if (patEnd > 0) {
        s = patEnd
        topCase.phase = 'body'
        topCase.maybe = ++this.reading.contexts
        continue
      }
    }
    break
  }
  s = skipSpaces(text, s, end)
  if (s >= end) return
  const topLoop = loopStack[loopStack.length - 1]
  if (topLoop !== undefined) currentFrame = { ...currentFrame, stages: topLoop.stages, around: currentFrame.around ?? topLoop.around }
  const caseMaybes = caseStack.flatMap(entry => (entry.maybe === undefined ? [] : [entry.maybe]))
  if (caseMaybes.length > 0) currentFrame = { ...currentFrame, maybes: [...(currentFrame.maybes ?? []), ...caseMaybes] }
  const stages = splitPipelineStages(text, s, end)
  if (stages.length === 1) {
    this.walkStage(text, stages[0]!.start, stages[0]!.end, currentFrame)
    return
  }
  const around = currentFrame.around ?? stripCommentsAndTrim(text, s, end)
  const pipeline = this.reading.pipelineSizes.push(stages.length) - 1
  for (const [stage, span] of stages.entries()) {
    const stageStages = [...currentFrame.stages, { pipeline, stage }]
    if (stage === stages.length - 1) {
      let leadAt = skipSpaces(text, span.start, span.end)
      while (leadAt < span.end && text[leadAt] === '!' && (leadAt + 1 === span.end || isSpace(text[leadAt + 1]))) leadAt = skipSpaces(text, leadAt + 1, span.end)
      const leadEnd = this.plainWordEnd(text, leadAt, span.end)
      const leadWord = text.slice(leadAt, leadEnd)
      if ((leadWord === 'while' || leadWord === 'until' || leadWord === 'for') && (leadEnd === span.end || isSpace(text[leadEnd]))) {
        loopStack.push({ stages: stageStages, around, depth: 1 })
      }
    }
    this.isolated(() => this.walkStage(text, span.start, span.end, { ...currentFrame, around, stages: stageStages }))
  }
  feedPipeline(this.reading, pipeline, stages.length)
}

function textWalkStage(this: TextWalk, text: string, start: number, end: number, frame: Frame): void {
  let s = skipSpaces(text, start, end)
  for (;;) {
    if (s >= end) return
    if (text[s] === '!' && (s + 1 === end || isSpace(text[s + 1]))) {
      s = skipSpaces(text, s + 1, end)
      continue
    }
    const wordEnd = this.plainWordEnd(text, s, end)
    const head = text.slice(s, wordEnd)
    if ((head === 'while' || head === 'until' || head === '{') && (wordEnd === end || isSpace(text[wordEnd]))) {
      s = skipSpaces(text, wordEnd, end)
      continue
    }
    break
  }
  if (s >= end) return
  if (text[s] === '(' && text[s + 1] === '(') {
    const close = findMatching(text, s, end, '(', ')', this.budget)
    if (close > s) this.scanSubstitutions(text, s + 2, close, frame)
    return
  }
  if (text[s] === '(') {
    const close = findMatching(text, s, end, '(', ')', this.budget)
    if (close > s) {
      const tailRedirects: ReadRedirect[] = []
      const tailInputInner: number[] = []
      let tailInput: string | undefined
      const tailText = stripCommentsAndTrim(text, close + 1, end)
      const onlyTail = tailText === '' || this.readTailRedirects(text, close + 1, end, frame, tailRedirects, tailInputInner, value => { tailInput = value })
      if (onlyTail) {
        const before = this.reading.commands.length
        const innerFrame = tailRedirects.length > 0 && frame.around === undefined ? { ...frame, around: stripCommentsAndTrim(text, s, end) } : frame
        this.isolated(() => this.walkNested(text.slice(s + 1, close), innerFrame))
        const at = this.reading.commands.length - 1
        const last = this.reading.commands[at]
        if (tailRedirects.length > 0 || tailInput !== undefined || tailInputInner.length > 0) {
          if (last !== undefined && at >= before) {
            last.redirects = [...last.redirects, ...tailRedirects]
            last.input ??= tailInput
            last.inputInner = [...last.inputInner, ...tailInputInner]
          } else {
            this.reading.push({ argv: [], env: [], redirects: tailRedirects, text: stripCommentsAndTrim(text, s, end), line: frame.line, cwd: this.reading.cwd, background: frame.background, stages: frame.stages, input: tailInput, inner: [], inputInner: tailInputInner, body: frame.body, dialect: frame.dialect, around: innerFrame.around, gates: frame.gates, maybes: frame.maybes, substituted: frame.substituted })
          }
        }
        return
      }
      this.isolated(() => this.walkNested(text.slice(s + 1, close), frame))
      this.walkUnit(text, close + 1, end, frame, [], [])
      return
    }
  }
  const stageText = stripCommentsAndTrim(text, s, end)
  if (stageText === '') return
  const words: TokenWord[] = []
  const env: Array<{ name: string; value: string }> = []
  const redirects: ReadRedirect[] = []
  const inputInner: number[] = []
  let input: string | undefined
  let at = s
  while (at < end) {
    at = skipSpaces(text, at, end)
    if (at >= end) break
    if (commentStart(text, at)) {
      while (at < end && text[at] !== '\n') at++
      continue
    }
    if (text[at] === '(' && text[at + 1] === '(') {
      const close = findMatching(text, at, end, '(', ')', this.budget)
      if (close > at) {
        this.scanSubstitutions(text, at + 2, close, frame)
        at = close + 1
        continue
      }
      at += 2
      continue
    }
    if (text[at] === '(') {
      const close = findMatching(text, at, end, '(', ')', this.budget)
      if (close > at) {
        this.isolated(() => this.walkNested(text.slice(at + 1, close), frame))
        at = close + 1
        continue
      }
      at++
      continue
    }
    if (text[at] === ')') {
      at++
      continue
    }
    if (text[at] === '<' && text[at + 1] === '(') {
      const word = this.readWord(text, at, end, frame)
      words.push(word)
      at = word.next
      continue
    }
    if (text[at] === '>' && text[at + 1] === '(') {
      const word = this.readWord(text, at, end, frame)
      words.push(word)
      at = word.next
      continue
    }
    const redir = REDIRECT_START.exec(text.slice(at, Math.min(end, at + 8)))
    if (redir !== null) {
      const op = redir[2]!
      at = skipSpaces(text, at + redir[0].length, end)
      if (at >= end) break
      if (op === '<<' || op === '<<-') {
        const delim = this.readWord(text, at, end, frame)
        at = delim.next
        continue
      }
      const target = this.readWord(text, at, end, frame)
      at = target.next
      if (op === '<<<') {
        input = target.values[0]
        continue
      }
      if (target.procSub) {
        if (op === '<') inputInner.push(...target.inner)
        continue
      }
      for (const value of target.values) redirects.push({ op, target: value })
      continue
    }
    const word = this.readWord(text, at, end, frame)
    if (word.next <= at) {
      at++
      continue
    }
    at = word.next
    if (words.length === 0 && !word.quoted) {
      const assigned = ASSIGNMENT_HEAD.exec(word.raw)
      if (assigned !== null) {
        const name = assigned[1]!
        const valStart = assigned[0].length
        const parsed = valStart < word.raw.length ? this.readWord(word.raw, valStart, word.raw.length, frame) : { values: [''], inner: [], raw: '', quoted: false, procSub: false, next: word.raw.length }
        env.push({ name, value: parsed.values[0] ?? '' })
        continue
      }
    }
    words.push(word)
  }
  if (words.length === 0) {
    for (const entry of env) this.reading.assign(entry.name, [entry.value])
    if (redirects.length > 0 || input !== undefined || inputInner.length > 0) {
      this.reading.push({ argv: [], env: [], redirects, text: stageText, line: frame.line, cwd: this.reading.cwd, background: frame.background, stages: frame.stages, input, inner: [], inputInner, body: frame.body, dialect: frame.dialect, around: frame.around, gates: frame.gates, maybes: frame.maybes, substituted: frame.substituted })
    }
    return
  }
  const first = words[0]!
  if (!first.quoted && (first.raw === '[' || first.raw === '[[' || first.raw === 'unset')) return
  if (!first.quoted && DECLARATIONS.has(first.raw)) {
    const exporting = first.raw === 'export'
    for (const arg of words.slice(1)) {
      if (arg.quoted) continue
      const assigned = ASSIGNMENT_HEAD.exec(arg.raw)
      if (assigned === null) continue
      const name = assigned[1]!
      const valStart = assigned[0].length
      const parsed = valStart < arg.raw.length ? this.readWord(arg.raw, valStart, arg.raw.length, frame) : { values: [''], inner: [], raw: '', quoted: false, procSub: false, next: arg.raw.length }
      this.reading.assign(name, parsed.values)
      if (exporting) this.reading.exported.set(name, parsed.values)
    }
    return
  }
  const written = words.map(word => word.raw)
  const readings = Math.min(READING_CAP, Math.max(1, ...words.map(word => word.values.length)))
  for (let k = 0; k < readings; k++) {
    const index = this.reading.push({
      argv: words.map(word => word.values[Math.min(k, word.values.length - 1)] ?? ''),
      env,
      redirects,
      text: stageText,
      line: frame.line,
      cwd: this.reading.cwd,
      background: frame.background,
      stages: frame.stages,
      input,
      inner: words.map(word => word.inner),
      inputInner,
      body: frame.body,
      dialect: frame.dialect,
      around: frame.around,
      gates: frame.gates,
      maybes: frame.maybes,
      substituted: frame.substituted,
    })
    keepWordsAsWritten(this.reading.commands[index], written)
  }
}

function textReadTailRedirects(this: TextWalk, text: string, start: number, end: number, frame: Frame, redirects: ReadRedirect[], inputInner: number[], onInput: (value: string | undefined) => void): boolean {
  let at = start
  while (at < end) {
    at = skipSpaces(text, at, end)
    if (at >= end) return true
    if (commentStart(text, at)) {
      while (at < end && text[at] !== '\n') at++
      continue
    }
    const redir = REDIRECT_START.exec(text.slice(at, Math.min(end, at + 8)))
    if (redir === null) return false
    const op = redir[2]!
    at = skipSpaces(text, at + redir[0].length, end)
    if (at >= end) return true
    if (op === '<<' || op === '<<-') {
      at = this.readWord(text, at, end, frame).next
      continue
    }
    const target = this.readWord(text, at, end, frame)
    at = target.next
    if (op === '<<<') onInput(target.values[0])
    else if (target.procSub) {
      if (op === '<') inputInner.push(...target.inner)
    } else for (const value of target.values) redirects.push({ op, target: value })
  }
  return true
}

function textScanSubstitutions(this: TextWalk, text: string, start: number, end: number, frame: Frame, heredoc = false): number[] {
  const inner: number[] = []
  let quote: '' | "'" | '"' = ''
  for (let i = start; i < end; i++) {
    const ch = text[i]!
    if (!heredoc && quote === "'") {
      if (ch === "'") quote = ''
      continue
    }
    if (ch === '\\') {
      i++
      continue
    }
    if (!heredoc && ch === "'" && quote === '') {
      quote = "'"
      continue
    }
    if (!heredoc && ch === '"') {
      quote = quote === '"' ? '' : '"'
      continue
    }
    if (ch === '$' && text[i + 1] === '(') {
      if (text[i + 2] === '(') {
        const close = findMatching(text, i + 1, end, '(', ')', this.budget)
        if (close > i) i = close
        continue
      }
      const close = findMatching(text, i + 1, end, '(', ')', this.budget)
      if (close > i) {
        inner.push(...this.runSubstitution(text.slice(i + 2, close), frame).inner)
        i = close
      }
      continue
    }
    if (ch === '`') {
      const close = findBacktickEnd(text, i, end, quote === '"', this.budget)
      if (close > i) {
        const raw = text.slice(i + 1, close)
        const script = quote === '"' ? raw.replace(/\\([$`"\\])/g, '$1') : raw.replace(/\\([$`\\])/g, '$1')
        inner.push(...this.runSubstitution(script, frame).inner)
        i = close
      }
    }
  }
  return inner
}

function textExpandVar(this: TextWalk, raw: string, braced: boolean, frame: Frame): Words {
  const inner: number[] = []
  let name: string | undefined
  if (braced) {
    const body = raw.slice(2, -1)
    const m = /^([A-Za-z_][A-Za-z0-9_]*|[?*@$#!0-9-])/.exec(body)
    name = m?.[1]
    if (body.includes('$(') || body.includes('`')) inner.push(...this.scanSubstitutions(body, 0, body.length, frame))
  } else {
    name = raw.slice(1)
  }
  const known = name === undefined ? undefined : this.reading.scope.get(name)
  if (known !== undefined && known.length > 0) return { values: [...known].reverse(), inner }
  if (name === 'PWD' && this.reading.cwd !== undefined && (!braced || raw === '${PWD}')) return { values: [this.reading.cwd], inner }
  const old = this.reading.world.returnsTo ?? this.reading.oldpwd
  if (name === 'OLDPWD' && old !== undefined && (!braced || raw === '${OLDPWD}')) return { values: [old], inner }
  return { values: [raw], inner }
}

function textReadDoubleQuoted(this: TextWalk, text: string, openAt: number, end: number, frame: Frame): { next: number; values: string[]; inner: number[] } {
  let values = ['']
  const inner: number[] = []
  let lit = ''
  const flush = (): void => {
    if (lit !== '') {
      values = cross(values, [lit])
      lit = ''
    }
  }
  let i = openAt + 1
  while (i < end) {
    const ch = text[i]!
    if (ch === '"') {
      flush()
      return { next: i + 1, values, inner }
    }
    if (ch === '\\' && i + 1 < end) {
      const next = text[i + 1]!
      if (next === '\n') i += 2
      else if (next === '$' || next === '`' || next === '"' || next === '\\') {
        lit += next
        i += 2
      } else {
        lit += ch + next
        i += 2
      }
      continue
    }
    if (ch === '$' && text[i + 1] === '(') {
      if (text[i + 2] === '(') {
        const close = findMatching(text, i + 1, end, '(', ')', this.budget)
        if (close > i) {
          flush()
          inner.push(...this.scanSubstitutions(text, i + 3, close, frame))
          values = cross(values, [UNREAD_PART])
          i = close + 1
          continue
        }
      } else {
        const close = findMatching(text, i + 1, end, '(', ')', this.budget)
        if (close > i) {
          flush()
          const sub = this.runSubstitution(text.slice(i + 2, close), frame)
          values = cross(values, sub.values)
          inner.push(...sub.inner)
          i = close + 1
          continue
        }
      }
    }
    if (ch === '`') {
      const close = findBacktickEnd(text, i, end, true, this.budget)
      if (close > i) {
        flush()
        const script = text.slice(i + 1, close).replace(/\\([$`"\\])/g, '$1')
        const sub = this.runSubstitution(script, frame)
        values = cross(values, sub.values)
        inner.push(...sub.inner)
        i = close + 1
        continue
      }
    }
    if (ch === '$' && text[i + 1] === '{') {
      const close = findMatching(text, i + 1, end, '{', '}', this.budget)
      if (close > i) {
        flush()
        const expanded = this.expandVar(text.slice(i, close + 1), true, frame)
        values = cross(values, expanded.values)
        inner.push(...expanded.inner)
        i = close + 1
        continue
      }
    }
    if (ch === '$') {
      const varEnd = scanSimpleVarEnd(text, i, end)
      if (varEnd > i + 1) {
        flush()
        const expanded = this.expandVar(text.slice(i, varEnd), false, frame)
        values = cross(values, expanded.values)
        inner.push(...expanded.inner)
        i = varEnd
        continue
      }
    }
    lit += ch
    i++
  }
  flush()
  return { next: end, values, inner }
}

function textReadWord(this: TextWalk, text: string, start: number, end: number, frame: Frame): TokenWord & { next: number } {
  if ((text[start] === '<' || text[start] === '>') && text[start + 1] === '(') {
    const close = findMatching(text, start + 1, end, '(', ')', this.budget)
    if (close > start) {
      const sub = this.runSubstitution(text.slice(start + 2, close), frame, true)
      return { next: close + 1, values: sub.values, inner: sub.inner, raw: text.slice(start, close + 1), quoted: false, procSub: true }
    }
  }
  let values = ['']
  const inner: number[] = []
  let lit = ''
  let quoted = false
  const flush = (): void => {
    if (lit !== '') {
      values = cross(values, [lit])
      lit = ''
    }
  }
  let i = start
  while (i < end) {
    const ch = text[i]!
    if (isSpace(ch) || ch === ';' || ch === '|' || ch === '&' || ch === '<' || ch === '>') break
    if (i > start && commentStart(text, i)) break
    if (ch === "'" ) {
      quoted = true
      flush()
      const close = text.indexOf("'", i + 1)
      const stop = close < 0 || close >= end ? end : close
      values = cross(values, [text.slice(i + 1, stop)])
      i = close < 0 || close >= end ? end : close + 1
      continue
    }
    if (ch === '$' && text[i + 1] === "'") {
      quoted = true
      flush()
      let j = i + 2
      while (j < end && text[j] !== "'") {
        if (text[j] === '\\') j++
        j++
      }
      values = cross(values, [ansiC(text.slice(i + 2, Math.min(j, end)))])
      i = j < end ? j + 1 : end
      continue
    }
    if (ch === '"' || (ch === '$' && text[i + 1] === '"')) {
      quoted = true
      flush()
      const dq = this.readDoubleQuoted(text, ch === '"' ? i : i + 1, end, frame)
      values = cross(values, dq.values)
      inner.push(...dq.inner)
      i = dq.next
      continue
    }
    if (ch === '\\' && i + 1 < end) {
      const next = text[i + 1]!
      if (next !== '\n') lit += next
      i += 2
      continue
    }
    if (ch === '$' && text[i + 1] === '(') {
      if (text[i + 2] === '(') {
        const close = findMatching(text, i + 1, end, '(', ')', this.budget)
        if (close > i) {
          flush()
          inner.push(...this.scanSubstitutions(text, i + 3, close, frame))
          values = cross(values, [UNREAD_PART])
          i = close + 1
          continue
        }
      } else {
        const close = findMatching(text, i + 1, end, '(', ')', this.budget)
        if (close > i) {
          flush()
          const sub = this.runSubstitution(text.slice(i + 2, close), frame)
          values = cross(values, sub.values)
          inner.push(...sub.inner)
          i = close + 1
          continue
        }
      }
    }
    if (ch === '`') {
      const close = findBacktickEnd(text, i, end, false, this.budget)
      if (close > i) {
        flush()
        const script = text.slice(i + 1, close).replace(/\\([$`\\])/g, '$1')
        const sub = this.runSubstitution(script, frame)
        values = cross(values, sub.values)
        inner.push(...sub.inner)
        i = close + 1
        continue
      }
    }
    if (ch === '$' && text[i + 1] === '{') {
      const close = findMatching(text, i + 1, end, '{', '}', this.budget)
      if (close > i) {
        flush()
        const expanded = this.expandVar(text.slice(i, close + 1), true, frame)
        values = cross(values, expanded.values)
        inner.push(...expanded.inner)
        i = close + 1
        continue
      }
    }
    if (ch === '$') {
      const varEnd = scanSimpleVarEnd(text, i, end)
      if (varEnd > i + 1) {
        flush()
        const expanded = this.expandVar(text.slice(i, varEnd), false, frame)
        values = cross(values, expanded.values)
        inner.push(...expanded.inner)
        i = varEnd
        continue
      }
    }
    if (i === start && ch === '~' && text[i + 1] === '+' && this.reading.cwd !== undefined && (i + 2 === end || text[i + 2] === '/' || isSpace(text[i + 2]))) {
      lit += this.reading.cwd
      i += 2
      continue
    }
    lit += ch
    i++
  }
  flush()
  return { next: i, values, inner, raw: text.slice(start, i), quoted, procSub: false }
}

export class TextWalk {
  constructor(
    readonly reading: Reading,
    readonly source: string,
    readonly depth = 0,
    readonly budget: ScanBudget = { left: source.length * 8 + 4096 },
  ) {}

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

  walk(frame: Frame): void {
    if (this.depth > MAX_NEST) return
    if (this.source.includes('<<')) {
      for (const entry of unquotedDroppedHeredocBodies(this.source)) {
        if (entry.body.includes('$(') || entry.body.includes('`')) {
          this.scanSubstitutions(entry.body, 0, entry.body.length, { ...frame, line: frame.line + entry.line - 1 }, true)
        }
      }
    }
    const folded = foldContinuations(dropHeredocBodies(this.source), 'posix')
    this.walkBlock(folded, frame)
  }

  walkNested(text: string, frame: Frame): void {
    if (this.depth >= MAX_NEST || text.trim() === '') return
    new TextWalk(this.reading, text, this.depth + 1, this.budget).walkBlock(text, frame)
  }

  walkBlock(text: string, frame: Frame): void {
    textWalkBlock.call(this, text, frame)
  }

  walkUnit(text: string, start: number, end: number, frame: Frame, caseStack: CaseState[], loopStack: LoopStage[]): void {
    textWalkUnit.call(this, text, start, end, frame, caseStack, loopStack)
  }

  plainWordEnd(text: string, start: number, end: number): number {
    let i = start
    while (i < end && !isSpace(text[i]) && text[i] !== ';' && text[i] !== '|' && text[i] !== '&') i++
    return i
  }

  skipCaseHeader(text: string, start: number, end: number): number {
    let at = skipSpaces(text, start + 4, end)
    if (at >= end) return -1
    const word = this.readWord(text, at, end, { background: false, stages: [], body: undefined, line: 1, dialect: 'posix', around: undefined })
    at = skipSpaces(text, word.next, end)
    if (text.slice(at, at + 2) === 'in' && (at + 2 >= end || isSpace(text[at + 2]))) return skipSpaces(text, at + 2, end)
    return -1
  }

  readListValues(text: string, frame: Frame): string[] {
    const out: string[] = []
    let at = 0
    while (at < text.length) {
      at = skipSpaces(text, at, text.length)
      if (at >= text.length) break
      const word = this.readWord(text, at, text.length, frame)
      out.push(...word.values)
      if (word.next <= at) break
      at = word.next
    }
    return out
  }

  walkStage(text: string, start: number, end: number, frame: Frame): void {
    textWalkStage.call(this, text, start, end, frame)
  }

  readTailRedirects(text: string, start: number, end: number, frame: Frame, redirects: ReadRedirect[], inputInner: number[], onInput: (value: string | undefined) => void): boolean {
    return textReadTailRedirects.call(this, text, start, end, frame, redirects, inputInner, onInput)
  }

  scanSubstitutions(text: string, start: number, end: number, frame: Frame, heredoc = false): number[] {
    return textScanSubstitutions.call(this, text, start, end, frame, heredoc)
  }

  runSubstitution(script: string, frame: Frame, processSub = false): Words {
    const before = this.reading.commands.length
    this.isolated(() => this.walkNested(script, { ...frame, substituted: true }))
    const inner: number[] = []
    for (let i = before; i < this.reading.commands.length; i++) inner.push(i)
    const named = processSub ? undefined : userPrintedBy(this.reading, inner)
    return { values: [named ?? UNREAD_PART], inner }
  }

  expandVar(raw: string, braced: boolean, frame: Frame): Words {
    return textExpandVar.call(this, raw, braced, frame)
  }

  readDoubleQuoted(text: string, openAt: number, end: number, frame: Frame): { next: number; values: string[]; inner: number[] } {
    return textReadDoubleQuoted.call(this, text, openAt, end, frame)
  }

  readWord(text: string, start: number, end: number, frame: Frame): TokenWord & { next: number } {
    return textReadWord.call(this, text, start, end, frame)
  }
}
