import type { ShellDialect } from './reading.js'

type ShellReading = { text: string; deletes: boolean }
type QuotedRun = { start: number; end: number; live: boolean; script?: ShellReading }
type ShellWord = { text: string; start: number; end: number }
type ShellUnit = { start: number; end: number; next: number; runs: QuotedRun[]; words: ShellWord[]; open: boolean }

const HEREDOC_OPERATOR = /^<<(-?)\s*(?:'([^']+)'|"([^"]+)"|(\\)?([A-Za-z_][A-Za-z0-9_]*))/
const TRAILING_BACKSLASHES = /\\+$/
const DELETE_WORDS = new Set(['rm', 'unlink', 'rmdir', 'rd', 'ri', 'del', 'erase', 'remove-item'])
const FIND_ACTIONS = new Set(['-delete', '-exec', '-execdir', '-ok', '-okdir'])
const STRING_RUNNERS = new Set(['eval', 'invoke-expression', 'iex'])
const POSIX_SHELL_WORDS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'ash', 'fish'])
const STDIN_SHELL_WORDS = new Set(['eval', 'source', '.', 'su', 'sudo', 'doas'])
const HEREDOC_WORD_BREAK = new Set([' ', '\t', '\r', ';', '|', '&', '(', ')', '<', '>'])
const COMMENT_PRECEDERS = new Set([' ', '\t', '\r', '\n', ';', '|', '&', '('])
const POWERSHELL_WORDS = new Set(['pwsh', 'powershell'])
const POSIX_SCRIPT_OPTION = /^-[a-z]*c[a-z]*$/i
const POWERSHELL_SCRIPT_OPTION = /^-c(?:o(?:m(?:m(?:a(?:n(?:d)?)?)?)?)?)?$/i
const CMD_SCRIPT_OPTION = /^\/\/?[ck]$/i
const LIVE_WORD_BREAK = /[\s|&;(){}<>`]+/
const SHELL_READ_DEPTH = 3

function feedsShell(word: string): boolean {
  const verb = shellVerbOf(word)
  return POSIX_SHELL_WORDS.has(verb) || STDIN_SHELL_WORDS.has(verb)
}

export function commentStart(text: string, at: number): boolean {
  return text[at] === '#' && (at === 0 || COMMENT_PRECEDERS.has(text[at - 1]!))
}

export function shellTextOutsideFileHeredocs(text: string): string {
  return dropHeredocBodies(text)
}

export function dropHeredocBodies(text: string): string {
  const lines = text.split('\n')
  const out: string[] = []
  const bodies: Array<{ terminator: string; dashed: boolean; literal: boolean; commands: boolean }> = []
  let quote: '' | "'" | '"' = ''
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]!
    const body = bodies[0]
    if (body !== undefined) {
      while (!body.literal && i + 1 < lines.length && (TRAILING_BACKSLASHES.exec(line)?.[0].length ?? 0) % 2 === 1) line = line.slice(0, -1) + lines[++i]!
      if ((body.dashed ? line.replace(/^\t+/, '') : line) === body.terminator) bodies.shift()
      else if (body.commands) out.push(line)
      continue
    }
    out.push(line)
    const opened = bodies.length
    let commands = false
    let word = -1
    const closeWord = (end: number): void => {
      if (word >= 0 && feedsShell(line.slice(word, end))) commands = true
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
          bodies.push({ terminator: m[2] ?? m[3] ?? m[5] ?? '', dashed: m[1] === '-', literal: m[5] === undefined || m[4] !== undefined, commands: false })
          k += m[0].length - 1
        }
      } else if (HEREDOC_WORD_BREAK.has(ch)) closeWord(k)
      else if (word < 0) word = k
    }
    closeWord(line.length)
    for (let b = opened; b < bodies.length; b++) bodies[b]!.commands = commands
  }
  return out.join('\n')
}

export function foldContinuations(text: string, dialect: ShellDialect): string {
  const joiner = dialect === 'powershell' ? '`' : '\\'
  let out = ''
  let quote: '' | "'" | '"' = ''
  let comment = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (comment) {
      if (ch === '\n') comment = false
      out += ch
    } else if (quote === "'") {
      if (ch === "'") quote = ''
      out += ch
    } else if (ch === joiner) {
      const next = text[i + 1]
      if (next === '\n') i++
      else if (next === '\r' && text[i + 2] === '\n') i += 2
      else if (next === undefined) out += ch
      else {
        out += ch + next
        i++
      }
    } else if (quote === '"') {
      if (ch === '"') quote = ''
      out += ch
    } else if (ch === "'" || ch === '"') {
      quote = ch
      out += ch
    } else if (commentStart(text, i)) {
      comment = true
      out += ch
    } else if (ch === '|' || (ch === '&' && text[i + 1] === '&')) {
      let j = i + 1
      if (text[j] === ch || (ch === '|' && text[j] === '&')) j++
      let k = j
      let newline = false
      for (;;) {
        while (text[k] === ' ' || text[k] === '\t' || text[k] === '\r') k++
        if (text[k] === '#') while (k < text.length && text[k] !== '\n') k++
        if (text[k] !== '\n') break
        newline = true
        k++
      }
      out += newline ? `${text.slice(i, j)} ` : text.slice(i, j)
      i = (newline ? k : j) - 1
    } else out += ch
  }
  return out
}

export function lexShellUnit(text: string, start: number, dialect: ShellDialect): ShellUnit {
  const runs: QuotedRun[] = []
  const words: ShellWord[] = []
  const escape = dialect === 'powershell' ? '`' : '\\'
  let quote: '' | "'" | '"' = ''
  let runStart = 0
  let live = false
  let word = -1
  let depth = 0
  let ticks = false
  const closeWord = (end: number): void => {
    if (word >= 0) words.push({ text: text.slice(word, end), start: word, end })
    word = -1
  }
  const unit = (end: number, next: number): ShellUnit => ({ start, end, next, runs, words, open: false })
  let i = start
  for (; i < text.length; i++) {
    const ch = text[i]!
    if (quote === "'") {
      if (ch === "'") {
        runs.push({ start: runStart, end: i, live: false })
        quote = ''
      }
      continue
    }
    if (quote === '"') {
      if (ch === escape) i++
      else if (ch === '"') {
        if (dialect === 'powershell' && text[i + 1] === '"') i++
        else {
          runs.push({ start: runStart, end: i, live })
          quote = ''
        }
      } else if ((ch === '$' && text[i + 1] === '(') || (dialect === 'posix' && ch === '`')) live = true
      continue
    }
    if (ch === escape) {
      if (word < 0) word = i
      i++
      continue
    }
    if (commentStart(text, i)) {
      closeWord(i)
      while (i + 1 < text.length && text[i + 1] !== '\n') i++
      continue
    }
    if (ch === "'" || ch === '"') {
      closeWord(i)
      quote = ch
      runStart = i + 1
      live = false
      continue
    }
    if (ch === '$' && text[i + 1] === '(') {
      closeWord(i)
      depth++
      i++
      continue
    }
    if (ch === '(' || ch === ')') {
      closeWord(i)
      if (ch === '(') depth++
      else if (depth > 0) depth--
      continue
    }
    if (ch === '`' && dialect === 'posix') {
      closeWord(i)
      ticks = !ticks
      continue
    }
    const nested = depth > 0 || ticks
    if (ch === '\n' || ch === ';') {
      closeWord(i)
      if (!nested) return unit(i, i + 1)
      continue
    }
    if (ch === '&') {
      closeWord(i)
      const pair = text[i + 1] === '&'
      if (!pair && (text[i + 1] === '>' || text[i - 1] === '>' || text[i - 1] === '<')) continue
      if (!nested) return unit(i, i + (pair ? 2 : 1))
      if (pair) i++
      continue
    }
    if (ch === '|') {
      closeWord(i)
      if (text[i + 1] === '|') {
        if (!nested) return unit(i, i + 2)
        i++
      } else if (text[i + 1] === '&') i++
      continue
    }
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '{' || ch === '}' || ch === '<' || ch === '>') {
      closeWord(i)
      continue
    }
    if (word < 0) word = i
  }
  closeWord(i)
  return { start, end: i, next: i, runs, words, open: quote !== '' }
}

function shellVerbOf(word: string): string {
  const cut = Math.max(word.lastIndexOf('/'), word.lastIndexOf('\\'))
  const name = (cut >= 0 ? word.slice(cut + 1) : word).toLowerCase()
  return name.endsWith('.exe') ? name.slice(0, -4) : name
}

function unquoteScript(content: string, quote: string, dialect: ShellDialect): string {
  if (dialect === 'powershell') return quote === '"' ? content.replace(/`(["`$])/g, '$1').replace(/""/g, '"') : content.replace(/''/g, "'")
  return quote === '"' ? content.replace(/\\(["\\$`])/g, '$1') : content
}

function shellUnitDeletes(text: string, unit: ShellUnit, dialect: ShellDialect, byCommandWord: boolean, depth: number): boolean {
  const words = unit.words.map(w => w.text)
  for (const run of unit.runs) if (run.live) words.push(...text.slice(run.start, run.end).split(LIVE_WORD_BREAK))
  for (const word of words) {
    const verb = shellVerbOf(word)
    if (DELETE_WORDS.has(verb)) return true
    if (verb === 'find' && words.some(w => FIND_ACTIONS.has(w.toLowerCase()))) return true
  }
  for (const [k, word] of unit.words.entries()) {
    const verb = shellVerbOf(word.text)
    const runner = STRING_RUNNERS.has(verb)
    const inner: ShellDialect | undefined =
      POSIX_SHELL_WORDS.has(verb) || verb === 'cmd' ? 'posix' : POWERSHELL_WORDS.has(verb) || (runner && dialect === 'powershell') ? 'powershell' : runner ? 'posix' : undefined
    if (inner === undefined) continue
    const option = runner ? word : unit.words.slice(k + 1).find(w => (verb === 'cmd' ? CMD_SCRIPT_OPTION : inner === 'posix' ? POSIX_SCRIPT_OPTION : POWERSHELL_SCRIPT_OPTION).test(w.text))
    if (option === undefined) continue
    const scripts = unit.runs.filter(run => run.start > option.end && !run.live && (runner || !unit.words.some(w => w.start >= option.end && w.end < run.start)))
    for (const run of runner ? scripts : scripts.slice(0, 1)) {
      if (depth >= SHELL_READ_DEPTH) return true
      run.script = readShellText(unquoteScript(text.slice(run.start, run.end), text[run.start - 1] ?? '', dialect), inner, byCommandWord, depth + 1)
      if (run.script.deletes) return true
    }
  }
  return false
}

function renderShellUnit(text: string, unit: ShellUnit, keepData: boolean): string {
  let out = ''
  let at = unit.start
  for (const run of unit.runs) {
    out += text.slice(at, run.start)
    out += run.script !== undefined ? run.script.text : keepData || run.live ? text.slice(run.start, run.end) : ''
    at = run.end
  }
  return out + text.slice(at, unit.next)
}

function readShellText(command: string, dialect: ShellDialect, byCommandWord: boolean, depth: number): ShellReading {
  const text = foldContinuations(dialect === 'posix' ? dropHeredocBodies(command) : command, dialect)
  let out = ''
  let deletes = false
  let at = 0
  while (at < text.length) {
    const unit = lexShellUnit(text, at, dialect)
    if (unit.open) return { text, deletes: true }
    const unitDeletes = shellUnitDeletes(text, unit, dialect, byCommandWord, depth)
    deletes ||= unitDeletes
    out += renderShellUnit(text, unit, byCommandWord && unitDeletes)
    at = unit.next
  }
  return { text: out, deletes }
}

export function readShellCommand(command: string, dialect: ShellDialect, byCommandWord: boolean): string {
  return readShellText(command, dialect, byCommandWord, 0).text
}
