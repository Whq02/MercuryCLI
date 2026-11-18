import { isMap, isScalar, isSeq, Lexer, parseDocument, Scalar } from 'yaml'
import { scriptComments } from './commentBytes.mjs'

type HashKind =
  | 'shell'
  | 'fish'
  | 'python'
  | 'yaml'
  | 'gdscript'
  | 'powershell'
  | 'toml'
  | 'sed'
  | 'typescript'
  | 'javascript'
  | 'csharp'
  | 'rust'
  | 'shader'
  | 'json'
  | 'nix'
  | 'ini'
  | 'ignore'
  | 'dockerfile'
type HashComment = { pos: number; end: number; keep: string | null; embedded: boolean }
type Form = 'comment' | 'module docstring' | 'docstring' | 'statement'
type Found = { pos: number; end: number; kind: HashKind; form: Form; embedded: boolean; kept?: string }
type Place = { path: string; text: string; pos: number; line: number; column: number; before: string; form: Form; embedded: boolean }
type KeepRule = { name: string; reader: string; kinds: HashKind[]; prose?: true; test: (comment: string, at: Place) => boolean }

const HASH_KINDS: [kind: HashKind, extensions: string[]][] = [
  ['typescript', ['ts', 'tsx', 'mts', 'cts']],
  ['javascript', ['js', 'mjs', 'cjs', 'jsx']],
  ['shell', ['sh', 'bash', 'zsh', 'command']],
  ['fish', ['fish']],
  ['python', ['py', 'pyi']],
  ['yaml', ['yml', 'yaml']],
  ['gdscript', ['gd']],
  ['powershell', ['ps1', 'psm1', 'psd1']],
  ['toml', ['toml']],
  ['sed', ['sed']],
  ['csharp', ['cs']],
  ['rust', ['rs']],
  ['shader', ['gdshader']],
  ['json', ['json', 'jsonc', 'asmdef']],
  ['nix', ['nix']],
  ['ini', ['cfg', 'godot', 'tscn', 'tres', 'import']],
]
export const PLAIN_EXTENSIONS = [
  'md', 'txt', 'patch', 'tsv', 'html', 'xml', 'svg', 'lock', 'sse', 'png', 'jsonl', 'sig', 'sha256', 'zip', 'xlsx', 'wav', 'typed', 'tgz', 'tar', 'tap', 'sqlite', 'rtf', 'pptx', 'pdf', 'odt', 'license', 'gif', 'epub', 'docx',
]
export const PLAIN_NAMES = ['LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES', '.node-version', 'media-memory']
const IGNORE_NAMES = ['.gitignore', '.gitattributes', '.dockerignore', '.npmignore']
const KIND_BY_EXTENSION = new Map<string, HashKind>(HASH_KINDS.flatMap(([kind, extensions]) => extensions.map((extension): [string, HashKind] => [extension, kind])))
const RUNNER = /^scripts\/[^/]+\/run-all\.sh$/
const HASH_STYLE: HashKind[] = ['shell', 'fish', 'python', 'yaml', 'gdscript', 'powershell', 'toml', 'sed', 'nix', 'ignore', 'dockerfile']

export const HASH_KEEP_RULES: KeepRule[] = [
  { name: 'shebang', reader: 'the kernel', kinds: ['shell', 'fish', 'python', 'sed'], test: (c, at) => !at.embedded && at.pos === 0 && /^#!\s*\/\S+( \S+)*$/.test(c) },
  {
    name: 'gate header',
    reader: 'scripts/verify/impactManifest.ts parseWatchHeader and parseClassHeader, scripts/lib/suite-env.sh suite_env_guard',
    kinds: ['shell'],
    test: (c, at) =>
      !at.embedded &&
      at.column === 0 &&
      RUNNER.test(at.path) &&
      !/^[^#\n]/m.test(at.text.slice(0, at.pos)) &&
      (/^# gate-class: (pure|cpu|pty|exclusive)$/.test(c) || /^# gate-env:( MERCURY_[A-Z0-9_]+)+$/.test(c) || /^# gate-watch:( [A-Za-z0-9_.@{},*+/!?[\]-]+)+$/.test(c)),
  },
  {
    name: 'action pin',
    reader: 'scripts/node-runtime/prove-workflow-toolchain.ts countPinned',
    kinds: ['yaml'],
    test: (c, at) => !at.embedded && /\buses: [\w.-]+\/[\w./-]+@[0-9a-f]{40} $/.test(at.before) && /^# (v\d+(\.\d+){0,2}|stable)$/.test(c),
  },
  {
    name: 'requires',
    reader: 'PowerShell',
    kinds: ['powershell'],
    test: (c, at) => at.before.trim() === '' && /^#requires -(version \d+(\.\d+){0,3}|psedition (core|desktop)|runasadministrator)$/i.test(c),
  },
  {
    name: 'generated marker',
    reader: "the product's generated-file ward (GENERATED_MARKER), and scripts/health/prove-deployed-assets.ts for the block the launcher embeds",
    kinds: HASH_STYLE,
    test: (c, at) => !at.embedded && /^# (generated|composed|managed) by (bun run |bun |node |bash |sh |python3? )?([A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.(ts|tsx|mts|mjs|cjs|js|sh|py)( — do not hand-edit)?$/.test(c),
  },
  {
    name: 'encoding',
    reader: 'CPython',
    kinds: ['python'],
    test: (c, at) => !at.embedded && at.line < 2 && /^# (-\*- coding: [-\w.]+ -\*-|coding[:=] ?[-\w.]+|vim: set fileencoding=[-\w.]+ :)$/.test(c),
  },
  { name: 'quiet', reader: 'sed', kinds: ['sed'], test: (c, at) => at.pos === 0 && c === '#n' },
  { name: 'compdef', reader: 'zsh compinit', kinds: ['shell'], test: (c, at) => !at.embedded && at.pos === 0 && /^#compdef( [\w.-]+)+$/.test(c) },
  {
    name: 'read docstring',
    reader: 'the module itself, through __doc__',
    kinds: ['python'],
    prose: true,
    test: (_c, at) => !at.embedded && at.form === 'module docstring' && /(^|[^\w.])__doc__\b/.test(at.text),
  },
  {
    name: 'sdk docstring',
    reader: "an SDK user's editor and help(), and scripts/sdk/prove-sdk-build.ts",
    kinds: ['python'],
    prose: true,
    test: (_c, at) => !at.embedded && at.path.startsWith('sdk-py/src/') && (at.form === 'docstring' || at.form === 'module docstring'),
  },
]

export const SCRIPT_KEEP_READERS: [name: string, reader: string][] = [
  ['reference', 'the TypeScript compiler'],
  ['ts directive', 'the TypeScript compiler'],
]

function lineEndOf(text: string, from: number): number {
  const n = text.indexOf('\n', from)
  return n === -1 ? text.length : n
}

function nameOf(path: string): { name: string; extension: string | null } {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  return { name, extension: dot > 0 ? name.slice(dot + 1).toLowerCase() : null }
}

export function hashCandidate(path: string): boolean {
  const { name, extension } = nameOf(path)
  if (IGNORE_NAMES.includes(name) || /\.dockerignore$/.test(name) || /^Dockerfile(\.|$)/.test(name)) return true
  if (extension === null) return !PLAIN_NAMES.includes(name)
  return KIND_BY_EXTENSION.has(extension)
}

export function hashKindOf(path: string, text: string): HashKind | null {
  const { name, extension } = nameOf(path)
  if (IGNORE_NAMES.includes(name) || /\.dockerignore$/.test(name)) return 'ignore'
  if (/^Dockerfile(\.|$)/.test(name)) return 'dockerfile'
  if (extension !== null) return KIND_BY_EXTENSION.get(extension) ?? null
  if (PLAIN_NAMES.includes(name) || text.includes('\u0000')) return null
  const first = text.slice(0, lineEndOf(text, 0))
  if (first.startsWith('#!')) {
    if (/\bpython[0-9.]*\b/.test(first)) return 'python'
    if (/\b(node|bun|deno)\b/.test(first)) return 'javascript'
    if (/\bfish\b/.test(first)) return 'fish'
    if (/\b(pwsh|powershell)\b/.test(first)) return 'powershell'
  }
  return 'shell'
}

type Frame = { kind: 'cmd' | 'paren' | 'sub' | 'tick' | 'dq' | 'param' | 'arith'; depth: number; cases: number; quoted: boolean }
type HereDocument = { word: string; tabs: boolean; command: string | null }

const COMMAND_WORDS = new Set(['then', 'do', 'else', 'elif', '{', '!', 'if', 'while', 'until', 'time'])

function shellFound(text: string, offset = 0, embedded = false): Found[] {
  const out: Found[] = []
  const stack: Frame[] = [{ kind: 'cmd', depth: 0, cases: 0, quoted: false }]
  const pending: HereDocument[] = []
  const n = text.length
  let i = 0
  let wordStart = true
  let commandPosition = true
  let word: string | null = ''
  let wordAtCommand = true
  let command: string | null = null
  const push = (kind: Frame['kind'], depth = 0, quoted = false): void => {
    stack.push({ kind, depth, cases: 0, quoted })
  }
  const enterCommand = (kind: 'sub' | 'tick'): void => {
    push(kind)
    wordStart = true
    commandPosition = true
    word = ''
    command = null
  }
  const endWord = (): void => {
    if (wordStart) return
    const frame = stack[stack.length - 1]!
    if (word === 'case' && wordAtCommand) frame.cases++
    else if (word === 'esac' && frame.cases > 0) frame.cases--
    if (wordAtCommand && word !== null && /^[A-Za-z_][A-Za-z0-9_]*\+?=/.test(word)) commandPosition = true
    else {
      if (wordAtCommand) command = word
      commandPosition = word !== null && COMMAND_WORDS.has(word)
    }
    wordStart = true
    word = ''
  }
  const beginWord = (plain: boolean, c = ''): void => {
    if (wordStart) {
      wordStart = false
      wordAtCommand = commandPosition
      word = ''
    }
    word = plain && word !== null ? word + c : null
  }
  const boundary = (): void => {
    endWord()
    commandPosition = true
    command = null
  }
  const skipSingle = (from: number): number => {
    const close = text.indexOf("'", from + 1)
    return close === -1 ? n : close + 1
  }
  const skipAnsi = (from: number): number => {
    let j = from + 2
    while (j < n && text[j] !== "'") j += text[j] === '\\' ? 2 : 1
    return Math.min(n, j + 1)
  }
  const skipOldArithmetic = (from: number): number => {
    let depth = 1
    let j = from + 2
    while (j < n && depth > 0) {
      if (text[j] === '[') depth++
      else if (text[j] === ']') depth--
      else if (text[j] === '\\') j++
      j++
    }
    return j
  }
  const dollar = (): boolean => {
    const next = text[i + 1]
    if (next === '(') {
      if (text[i + 2] === '(') {
        push('arith', 2)
        i += 3
      } else {
        enterCommand('sub')
        i += 2
      }
      return true
    }
    if (next === '[') {
      i = skipOldArithmetic(i)
      return true
    }
    if (next === '{') {
      const outer = stack[stack.length - 1]!
      push('param', 0, outer.kind === 'dq' || (outer.kind === 'param' && outer.quoted))
      i += 2
      return true
    }
    return false
  }
  const body = (doc: HereDocument, from: number, to: number): void => {
    if (to <= from || doc.command === null) return
    const inner = text.slice(from, to)
    if (doc.command === ':' || doc.command === 'true') out.push({ pos: offset + from, end: offset + to - (inner.endsWith('\n') ? 1 : 0), kind: 'shell', form: 'comment', embedded: true })
    else if (/^python[0-9.]*$/.test(doc.command)) out.push(...pythonFound(inner, 'python', offset + from, true))
    else if (/^(ba|da|z)?sh$/.test(doc.command)) out.push(...shellFound(inner, offset + from, true))
  }
  while (i < n) {
    const c = text[i]!
    const frame = stack[stack.length - 1]!
    if (frame.kind === 'dq') {
      if (c === '\\') i += 2
      else if (c === '"') {
        stack.pop()
        i++
      } else if (c === '`') {
        enterCommand('tick')
        i++
      } else if (!(c === '$' && dollar())) i++
      continue
    }
    if (frame.kind === 'param') {
      if (c === '\\') i += 2
      else if (c === '}') {
        stack.pop()
        i++
      } else if (c === '"') {
        push('dq')
        i++
      } else if (c === "'" && !frame.quoted) i = skipSingle(i)
      else if (c === '`') {
        enterCommand('tick')
        i++
      } else if (!(c === '$' && dollar())) i++
      continue
    }
    if (frame.kind === 'arith') {
      if (c === '\\') i += 2
      else if (c === '(') {
        frame.depth++
        i++
      } else if (c === ')') {
        frame.depth--
        if (frame.depth === 0) stack.pop()
        i++
      } else if (c === '"') {
        push('dq')
        i++
      } else if (c === "'") i = skipSingle(i)
      else if (!(c === '$' && dollar())) i++
      continue
    }
    if (c === '\n') {
      boundary()
      i++
      while (pending.length > 0) {
        const doc = pending.shift()!
        const from = i
        let to = n
        while (i < n) {
          const end = lineEndOf(text, i)
          const line = text.slice(i, end)
          const lineStart = i
          i = end < n ? end + 1 : end
          if ((doc.tabs ? line.replace(/^\t+/, '') : line) === doc.word) {
            to = lineStart
            break
          }
        }
        body(doc, from, to)
      }
      continue
    }
    if (c === ' ' || c === '\t' || c === '\r') {
      endWord()
      i++
      continue
    }
    if (c === '\\') {
      if (text[i + 1] !== '\n') beginWord(false)
      i += 2
      continue
    }
    if (c === '#' && wordStart) {
      let end = lineEndOf(text, i)
      if (frame.kind === 'tick') {
        const tick = text.indexOf('`', i)
        if (tick !== -1 && tick < end) end = tick
      }
      out.push({ pos: offset + i, end: offset + end, kind: 'shell', form: 'comment', embedded })
      i = end
      continue
    }
    if (c === "'") {
      beginWord(false)
      i = skipSingle(i)
      continue
    }
    if (c === '"') {
      beginWord(false)
      push('dq')
      i++
      continue
    }
    if (c === '`') {
      if (frame.kind === 'tick') {
        endWord()
        stack.pop()
        wordStart = false
        word = null
      } else {
        beginWord(false)
        enterCommand('tick')
      }
      i++
      continue
    }
    if (c === '$') {
      beginWord(false)
      if (text[i + 1] === "'") i = skipAnsi(i)
      else if (!dollar()) i += text[i + 1] === '#' ? 2 : 1
      continue
    }
    if (c === '(') {
      const opensArith = wordStart && text[i + 1] === '('
      boundary()
      if (opensArith) {
        push('arith', 2)
        i += 2
      } else {
        push('paren')
        i++
      }
      continue
    }
    if (c === ')') {
      endWord()
      if ((frame.kind === 'paren' || frame.kind === 'sub') && frame.cases === 0) {
        stack.pop()
        if (frame.kind === 'sub') {
          wordStart = false
          word = null
        } else commandPosition = false
      } else commandPosition = true
      i++
      continue
    }
    if (c === ';' || c === '&' || c === '|') {
      boundary()
      i++
      continue
    }
    if (c === '<' || c === '>') {
      endWord()
      const reader = command
      if (c !== '<' || text[i + 1] !== '<') {
        i++
        continue
      }
      if (text[i + 2] === '<') {
        i += 3
        continue
      }
      let j = i + 2
      const tabs = text[j] === '-'
      if (tabs) j++
      while (text[j] === ' ' || text[j] === '\t') j++
      let delimiter = ''
      while (j < n && !/[\s;&|()<>]/.test(text[j]!)) {
        const d = text[j]!
        if (d === "'" || d === '"') {
          const close = text.indexOf(d, j + 1)
          if (close === -1) break
          delimiter += text.slice(j + 1, close)
          j = close + 1
        } else if (d === '\\') {
          delimiter += text[j + 1] ?? ''
          j += 2
        } else {
          delimiter += d
          j++
        }
      }
      if (delimiter !== '') pending.push({ word: delimiter, tabs, command: reader })
      i = j
      continue
    }
    beginWord(true, c)
    i++
  }
  return out
}

function fishFound(text: string): Found[] {
  const out: Found[] = []
  const n = text.length
  let i = 0
  let tokenStart = true
  while (i < n) {
    const c = text[i]!
    if (c === '#' && tokenStart) {
      const end = lineEndOf(text, i)
      out.push({ pos: i, end, kind: 'fish', form: 'comment', embedded: false })
      i = end
    } else if (c === "'" || c === '"') {
      i++
      while (i < n && text[i] !== c) i += text[i] === '\\' ? 2 : 1
      i++
      tokenStart = false
    } else if (c === '\\') {
      i += 2
      tokenStart = false
    } else {
      tokenStart = /[\s;|&(]/.test(c)
      i++
    }
  }
  return out
}

const STRING_PREFIX = /^(?:[rRuUbB]|[bB][rR]|[rR][bB])?(?=['"])/
const FORMAT_PREFIX = /^(?:[fF]|[fF][rR]|[rR][fF])(?=['"])/

function pythonFound(text: string, kind: 'python' | 'gdscript', offset = 0, embedded = false): Found[] {
  const out: Found[] = []
  const n = text.length
  const multiline = kind === 'gdscript'
  let i = 0
  let depth = 0
  let code = false
  let onlyStrings = true
  let firstString = -1
  let lastString = -1
  let keyword = ''
  let colon = false
  let first = true
  let header = false
  const skipString = (from: number): number => {
    const quote = text[from]!
    const triple = text.startsWith(quote.repeat(3), from)
    const close = triple ? quote.repeat(3) : quote
    let j = from + close.length
    while (j < n) {
      if (text[j] === '\\') j += 2
      else if (text.startsWith(close, j)) return j + close.length
      else if (!triple && !multiline && text[j] === '\n') return j
      else j++
    }
    return n
  }
  const endLine = (): void => {
    if (code && onlyStrings && firstString !== -1) out.push({ pos: offset + firstString, end: offset + lastString, kind, form: kind === 'gdscript' ? 'statement' : first ? 'module docstring' : header ? 'docstring' : 'statement', embedded })
    if (code) {
      header = colon && (keyword === 'def' || keyword === 'class')
      first = false
    }
    code = false
    onlyStrings = true
    firstString = -1
    lastString = -1
    keyword = ''
    colon = false
  }
  while (i < n) {
    const c = text[i]!
    if (c === '#') {
      const end = lineEndOf(text, i)
      out.push({ pos: offset + i, end: offset + end, kind, form: 'comment', embedded })
      i = end
      continue
    }
    if (c === '\n') {
      if (depth === 0) endLine()
      i++
      continue
    }
    if (c === '\\' && text[i + 1] === '\n') {
      i += 2
      continue
    }
    if (c === ' ' || c === '\t' || c === '\r' || c === '\f') {
      i++
      continue
    }
    const prefix = c === '"' || c === "'" ? '' : STRING_PREFIX.exec(text.slice(i, i + 3))?.[0]
    if (prefix !== undefined && (prefix === '' || !/[\w.]/.test(text[i - 1] ?? ''))) {
      const start = i
      i = skipString(i + prefix.length)
      if (depth === 0) {
        if (!code) firstString = start
        if (onlyStrings) lastString = i
        code = true
        colon = false
      }
      continue
    }
    const format = FORMAT_PREFIX.exec(text.slice(i, i + 3))?.[0]
    if (format !== undefined && !/[\w.]/.test(text[i - 1] ?? '')) {
      i = skipString(i + format.length)
      code = true
      onlyStrings = false
      colon = false
      continue
    }
    if (depth === 0 && !code && /[A-Za-z_]/.test(c)) {
      const word = /^[A-Za-z_]\w*/.exec(text.slice(i, i + 40))![0]
      keyword = word === 'async' ? (/^async\s+def\b/.test(text.slice(i, i + 40)) ? 'def' : word) : word
      code = true
      onlyStrings = false
      colon = false
      i += word.length
      continue
    }
    if (c === '(' || c === '[' || c === '{') depth++
    else if (c === ')' || c === ']' || c === '}') depth = Math.max(0, depth - 1)
    code = true
    onlyStrings = false
    colon = depth === 0 && c === ':'
    i++
  }
  if (depth === 0) endLine()
  return out
}

type QuoteRules = { backslash: (quote: string) => boolean; multiline: boolean }

function quotedFound(text: string, kind: HashKind, rules: QuoteRules): Found[] {
  const out: Found[] = []
  const n = text.length
  let i = 0
  while (i < n) {
    const c = text[i]!
    if (c === '#') {
      const end = lineEndOf(text, i)
      out.push({ pos: i, end, kind, form: 'comment', embedded: false })
      i = end
      continue
    }
    if (c !== '"' && c !== "'") {
      i++
      continue
    }
    const triple = text.startsWith(c.repeat(3), i)
    const quote = triple ? c.repeat(3) : c
    const escapes = rules.backslash(quote)
    i += quote.length
    while (i < n) {
      if (escapes && text[i] === '\\') i += 2
      else if (text.startsWith(quote, i)) {
        i += quote.length
        break
      } else if (!triple && !rules.multiline && text[i] === '\n') break
      else i++
    }
  }
  return out
}

function powershellFound(text: string, offset = 0, embedded = false): Found[] {
  const out: Found[] = []
  const n = text.length
  let i = 0
  while (i < n) {
    const c = text[i]!
    if (c === '<' && text[i + 1] === '#') {
      const close = text.indexOf('#>', i + 2)
      const end = close === -1 ? n : close + 2
      out.push({ pos: offset + i, end: offset + end, kind: 'powershell', form: 'comment', embedded })
      i = end
    } else if (c === '@' && (text[i + 1] === '"' || text[i + 1] === "'") && /^[ \t]*\r?\n/.test(text.slice(i + 2, i + 80))) {
      const close = text.indexOf(`\n${text[i + 1]}@`, i + 2)
      i = close === -1 ? n : close + 3
    } else if (c === '#' && (i === 0 || !/[\w.:\\$#`@~-]/.test(text[i - 1]!))) {
      const end = lineEndOf(text, i)
      out.push({ pos: offset + i, end: offset + end, kind: 'powershell', form: 'comment', embedded })
      i = end
    } else if (c === "'") {
      i++
      while (i < n && !(text[i] === "'" && text[i + 1] !== "'")) i += text[i] === "'" ? 2 : 1
      i++
    } else if (c === '"') {
      i++
      while (i < n && text[i] !== '"') i += text[i] === '`' ? 2 : 1
      i++
    } else if (c === '`') i += 2
    else i++
  }
  return out
}

function sedFound(text: string): Found[] {
  const out: Found[] = []
  const n = text.length
  let i = 0
  const delimited = (from: number, delimiter: string): number => {
    let j = from
    while (j < n && text[j] !== delimiter) {
      if (text[j] === '\\') j += 2
      else if (text[j] === '[') {
        j++
        if (text[j] === '^') j++
        if (text[j] === ']') j++
        while (j < n && text[j] !== ']' && text[j] !== '\n') j++
        j++
      } else if (text[j] === '\n') return j
      else j++
    }
    return j + 1
  }
  const address = (from: number): number => {
    let j = from
    for (;;) {
      if (/[0-9$~]/.test(text[j] ?? '')) while (/[0-9$~+]/.test(text[j] ?? '')) j++
      else if (text[j] === '/') j = delimited(j + 1, '/')
      else if (text[j] === '\\' && text[j + 1] !== undefined && text[j + 1] !== '\n') j = delimited(j + 2, text[j + 1]!)
      else return j
      while (/[IM]/.test(text[j] ?? '')) j++
      while (text[j] === ' ' || text[j] === '\t') j++
      if (text[j] !== ',') return j
      j++
      while (text[j] === ' ' || text[j] === '\t') j++
    }
  }
  while (i < n) {
    while (i < n && /[\s;{}]/.test(text[i]!)) i++
    if (i >= n) break
    if (text[i] === '#') {
      const end = lineEndOf(text, i)
      out.push({ pos: i, end, kind: 'sed', form: 'comment', embedded: false })
      i = end
      continue
    }
    i = address(i)
    while (text[i] === ' ' || text[i] === '\t' || text[i] === '!') i++
    const command = text[i]
    if (command === undefined || command === '\n') continue
    i++
    if (command === 's') {
      const delimiter = text[i]!
      i = delimited(delimited(i + 1, delimiter), delimiter)
      while (/[gpIiMme0-9]/.test(text[i] ?? '')) i++
      if (text[i] === 'w') i = lineEndOf(text, i)
    } else if (command === 'y') {
      const delimiter = text[i]!
      i = delimited(delimited(i + 1, delimiter), delimiter)
    } else if ('aic'.includes(command)) {
      let end = lineEndOf(text, i)
      while (text[end - 1] === '\\' && end < n) end = lineEndOf(text, end + 1)
      i = end
    } else if ('rRwW:'.includes(command)) i = lineEndOf(text, i)
    else if ('btT'.includes(command)) while (i < n && !/[;\n}]/.test(text[i]!)) i++
    else if (command === '#') {
      const end = lineEndOf(text, i - 1)
      out.push({ pos: i - 1, end, kind: 'sed', form: 'comment', embedded: false })
      i = end
    }
  }
  return out
}

type SlashRules = { verbatim: boolean; raw: boolean; nested: boolean; lifetimes: boolean }

function slashFound(text: string, kind: HashKind, rules: SlashRules): Found[] {
  const out: Found[] = []
  const n = text.length
  let i = 0
  const plain = (from: number): number => {
    let j = from + 1
    while (j < n && text[j] !== '"') j += text[j] === '\\' ? 2 : 1
    return j + 1
  }
  while (i < n) {
    const c = text[i]!
    if (c === '/' && text[i + 1] === '/') {
      const end = lineEndOf(text, i)
      out.push({ pos: i, end, kind, form: 'comment', embedded: false })
      i = end
    } else if (c === '/' && text[i + 1] === '*') {
      let depth = 1
      let j = i + 2
      while (j < n && depth > 0) {
        if (rules.nested && text[j] === '/' && text[j + 1] === '*') {
          depth++
          j += 2
        } else if (text[j] === '*' && text[j + 1] === '/') {
          depth--
          j += 2
        } else j++
      }
      out.push({ pos: i, end: j, kind, form: 'comment', embedded: false })
      i = j
    } else if (rules.verbatim && (c === '@' || c === '$') && /^[@$]{1,2}"/.test(text.slice(i, i + 3)) && text.slice(i, i + 3).includes('@')) {
      let j = text.indexOf('"', i) + 1
      while (j < n && !(text[j] === '"' && text[j + 1] !== '"')) j += text[j] === '"' ? 2 : 1
      i = j + 1
    } else if (rules.verbatim && c === '"' && text.startsWith('"""', i)) {
      let quotes = 3
      while (text[i + quotes] === '"') quotes++
      const close = text.indexOf('"'.repeat(quotes), i + quotes)
      i = close === -1 ? n : close + quotes
    } else if (rules.raw && (c === 'r' || c === 'b') && /^b?r#*"/.test(text.slice(i, i + 12)) && !/\w/.test(text[i - 1] ?? '')) {
      const open = /^b?r(#*)"/.exec(text.slice(i, i + 12))!
      const close = text.indexOf(`"${open[1]}`, i + open[0].length)
      i = close === -1 ? n : close + 1 + open[1]!.length
    } else if (c === '"') i = plain(i)
    else if (c === "'") {
      if (text[i + 1] === '\\') {
        const close = text.indexOf("'", i + 3)
        i = close === -1 ? n : close + 1
      } else if (text[i + 2] === "'") i += 3
      else if (rules.lifetimes) i++
      else {
        const close = text.indexOf("'", i + 1)
        i = close === -1 || close > lineEndOf(text, i) ? i + 1 : close + 1
      }
    } else i++
  }
  return out
}

function nixFound(text: string): Found[] {
  const out: Found[] = []
  const n = text.length
  let i = 0
  while (i < n) {
    const c = text[i]!
    if (c === '#') {
      const end = lineEndOf(text, i)
      out.push({ pos: i, end, kind: 'nix', form: 'comment', embedded: false })
      i = end
    } else if (c === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2)
      const end = close === -1 ? n : close + 2
      out.push({ pos: i, end, kind: 'nix', form: 'comment', embedded: false })
      i = end
    } else if (c === "'" && text[i + 1] === "'") {
      let j = i + 2
      while (j < n && !(text[j] === "'" && text[j + 1] === "'" && text[j + 2] !== "'" && text[j + 2] !== '$' && text[j + 2] !== '\\')) j += text[j] === "'" && text[j + 1] === "'" ? 3 : 1
      i = j + 2
    } else if (c === '"') {
      i++
      while (i < n && text[i] !== '"') i += text[i] === '\\' ? 2 : 1
      i++
    } else i++
  }
  return out
}

function lineFound(text: string, kind: HashKind, mark: string): Found[] {
  const out: Found[] = []
  let i = 0
  while (i < text.length) {
    const end = lineEndOf(text, i)
    const indent = /^[ \t]*/.exec(text.slice(i, end))![0].length
    if (text[i + indent] === mark) out.push({ pos: i + indent, end, kind, form: 'comment', embedded: false })
    i = end + 1
  }
  return out
}

function jsonFound(text: string): Found[] {
  const out: Found[] = []
  const n = text.length
  let i = 0
  while (i < n) {
    const c = text[i]!
    if (c === '"') {
      i++
      while (i < n && text[i] !== '"' && text[i] !== '\n') i += text[i] === '\\' ? 2 : 1
      i++
    } else if (c === '/' && text[i + 1] === '/') {
      const end = lineEndOf(text, i)
      out.push({ pos: i, end, kind: 'json', form: 'comment', embedded: false })
      i = end
    } else if (c === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2)
      const end = close === -1 ? n : close + 2
      out.push({ pos: i, end, kind: 'json', form: 'comment', embedded: false })
      i = end
    } else i++
  }
  return out
}

function scriptFound(path: string, text: string, kind: 'typescript' | 'javascript', offset = 0, embedded = false): Found[] {
  return scriptComments(path, text).map(range => ({ pos: offset + range.pos, end: offset + range.end, kind, form: 'comment' as const, embedded, ...(range.keep === null ? {} : { kept: range.keep }) }))
}

function yamlFound(text: string): Found[] {
  const out: Found[] = []
  let offset = 0
  let scalar = false
  for (const token of new Lexer().lex(text)) {
    if (token === '\u0002' || token === '\u0018' || token === '\u001f') {
      scalar = token === '\u001f'
      continue
    }
    if (!scalar && token.startsWith('#')) out.push({ pos: offset, end: offset + token.length, kind: 'yaml', form: 'comment', embedded: false })
    scalar = false
    offset += token.length
  }
  return out
}

function stringAt(node: unknown, path: string[]): string | null {
  const value = isMap(node) ? node.getIn(path) : undefined
  return typeof value === 'string' ? value : null
}

function blockFound(body: string, language: string, name: string): Found[] {
  if (/^(ba|da|z)?sh\b/.test(language)) return shellFound(body, 0, true)
  if (/^(pwsh|powershell)\b/.test(language)) return powershellFound(body, 0, true)
  if (/^python/.test(language)) return pythonFound(body, 'python', 0, true)
  if (language === 'javascript') return scriptFound(`${name}.js`, body, 'javascript', 0, true)
  return []
}

function embeddedIn(text: string, node: unknown, language: string): Found[] {
  if (!isScalar(node) || typeof node.value !== 'string' || !node.range) return []
  if (node.type === Scalar.BLOCK_LITERAL) {
    const bodyStart = lineEndOf(text, node.range[0]) + 1
    const lines = text.slice(bodyStart, node.range[1]).split('\n')
    const filled = lines.filter(line => line.trim() !== '')
    if (filled.length === 0) return []
    const indent = Math.min(...filled.map(line => /^ */.exec(line)![0].length))
    const sourceStarts: number[] = []
    const bodyStarts: number[] = []
    let sourceAt = bodyStart
    let bodyAt = 0
    const body = lines.map(line => {
      const dedented = line.slice(indent)
      sourceStarts.push(sourceAt)
      bodyStarts.push(bodyAt)
      sourceAt += line.length + 1
      bodyAt += dedented.length + 1
      return dedented
    })
    const place = (at: number): number => {
      let line = 0
      while (line + 1 < bodyStarts.length && bodyStarts[line + 1]! <= at) line++
      return at + sourceStarts[line]! + Math.min(indent, lines[line]!.length) - bodyStarts[line]!
    }
    return blockFound(body.join('\n'), language, 'block').map(found => ({ ...found, pos: place(found.pos), end: place(Math.max(found.pos, found.end - 1)) + 1 }))
  }
  const value = node.value
  const source = text.slice(node.range[0], node.range[1])
  return blockFound(value, language, 'block').map(found => {
    const words = value.slice(found.pos, found.end).split('\n')[0]!
    let at = -1
    for (let length = Math.min(words.length, 40); length >= 2 && at === -1; length--) at = source.indexOf(words.slice(0, length))
    const pos = node.range![0] + Math.max(0, at)
    return { ...found, pos, end: Math.min(lineEndOf(text, pos), node.range![1]) }
  })
}

function runBlockFound(text: string): Found[] {
  if (!/^(jobs|runs):/m.test(text)) return []
  const root = parseDocument(text).contents
  if (!isMap(root)) return []
  const out: Found[] = []
  const steps = (list: unknown, fallback: string): void => {
    if (!isSeq(list)) return
    for (const step of list.items) {
      if (!isMap(step)) continue
      out.push(...embeddedIn(text, step.get('run', true), stringAt(step, ['shell']) ?? fallback))
      const uses = stringAt(step, ['uses'])
      const inputs = step.get('with')
      if (uses !== null && /^actions\/github-script@/.test(uses) && isMap(inputs)) out.push(...embeddedIn(text, inputs.get('script', true), 'javascript'))
    }
  }
  const jobs = root.get('jobs')
  if (isMap(jobs))
    for (const pair of jobs.items) {
      const job = pair.value
      if (!isMap(job)) continue
      const runner = job.get('runs-on', true)
      const named = isScalar(runner) && typeof runner.value === 'string' ? runner.value : isSeq(runner) ? runner.items.map(item => (isScalar(item) ? String(item.value) : '')).join(' ') : ''
      const literal = named.includes('${{') ? [...named.matchAll(/'([^']*)'/g)].map(match => match[1]!).join(' ') : named
      const platform = /windows/i.test(literal) ? 'pwsh' : 'bash'
      steps(job.get('steps'), stringAt(job, ['defaults', 'run', 'shell']) ?? stringAt(root, ['defaults', 'run', 'shell']) ?? platform)
    }
  const runs = root.get('runs')
  if (isMap(runs)) steps(runs.get('steps'), 'bash')
  return out
}

const TOML_QUOTES: QuoteRules = { backslash: quote => quote[0] === '"', multiline: false }
const CSHARP: SlashRules = { verbatim: true, raw: false, nested: false, lifetimes: false }
const RUST: SlashRules = { verbatim: false, raw: true, nested: true, lifetimes: true }
const SHADER: SlashRules = { verbatim: false, raw: false, nested: false, lifetimes: false }

function found(path: string, text: string, kind: HashKind): Found[] {
  switch (kind) {
    case 'shell':
      return shellFound(text)
    case 'fish':
      return fishFound(text)
    case 'python':
    case 'gdscript':
      return pythonFound(text, kind)
    case 'yaml':
      return [...yamlFound(text), ...runBlockFound(text)].sort((a, b) => a.pos - b.pos)
    case 'powershell':
      return powershellFound(text)
    case 'toml':
      return quotedFound(text, kind, TOML_QUOTES)
    case 'sed':
      return sedFound(text)
    case 'typescript':
    case 'javascript':
      return scriptFound(path, text, kind)
    case 'csharp':
      return slashFound(text, kind, CSHARP)
    case 'rust':
      return slashFound(text, kind, RUST)
    case 'shader':
      return slashFound(text, kind, SHADER)
    case 'json':
      return jsonFound(text)
    case 'nix':
      return nixFound(text)
    case 'ini':
      return lineFound(text, kind, ';')
    case 'ignore':
    case 'dockerfile':
      return lineFound(text, kind, '#')
  }
}

export function hashComments(path: string, text: string): HashComment[] {
  const kind = hashKindOf(path, text)
  if (kind === null) return []
  return found(path, text, kind).map(range => {
    const lineStart = text.lastIndexOf('\n', range.pos - 1) + 1
    let line = 0
    for (let at = text.indexOf('\n'); at !== -1 && at < range.pos; at = text.indexOf('\n', at + 1)) line++
    const comment = text.slice(range.pos, range.end).replace(/\r$/, '')
    const place: Place = { path, text, pos: range.pos, line, column: range.pos - lineStart, before: text.slice(lineStart, range.pos), form: range.form, embedded: range.embedded }
    const kept = range.kept ?? HASH_KEEP_RULES.find(rule => rule.kinds.includes(range.kind) && rule.test(comment, place))?.name
    return { pos: range.pos, end: range.end, keep: kept ?? null, embedded: range.embedded }
  })
}
