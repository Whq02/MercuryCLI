import { isMap, isScalar, isSeq, Lexer, parseDocument, Scalar } from 'yaml'

export type HashKind = 'shell' | 'python' | 'yaml' | 'gdscript' | 'powershell' | 'toml' | 'sed'
export type HashComment = { pos: number; end: number; keep: string | null; embedded: boolean }

type Range = { pos: number; end: number }
type Place = { pos: number; line: number; column: number; before: string }
type KeepRule = { name: string; kinds: HashKind[] | 'all'; test: (comment: string, at: Place) => boolean }

const KIND_BY_EXTENSION = new Map<string, HashKind>([
  ['sh', 'shell'],
  ['bash', 'shell'],
  ['py', 'python'],
  ['yml', 'yaml'],
  ['yaml', 'yaml'],
  ['gd', 'gdscript'],
  ['ps1', 'powershell'],
  ['toml', 'toml'],
  ['sed', 'sed'],
])

export const HASH_KEEP_RULES: KeepRule[] = [
  { name: 'shebang', kinds: 'all', test: (c, at) => at.pos === 0 && c.startsWith('#!') },
  { name: 'gate header', kinds: ['shell'], test: (c, at) => at.column === 0 && /^# gate-(watch|class|env):/.test(c) },
  { name: 'shellcheck', kinds: ['shell'], test: c => /^#\s*shellcheck\s+[a-z-]+=/.test(c) },
  { name: 'generated marker', kinds: 'all', test: c => /^#\s*(generated|composed|managed) by\s+`?(bun run |bun |node |bash |sh |python3? )?([A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.(ts|tsx|mts|mjs|cjs|js|sh|py)\b/.test(c) },
  { name: 'encoding', kinds: ['python'], test: (c, at) => at.line < 2 && /^#.*coding[:=]\s*[-\w.]+/.test(c) },
  { name: 'type', kinds: ['python'], test: c => /^#\s*type:\s*\S/.test(c) },
  { name: 'noqa', kinds: ['python'], test: c => /^#\s*noqa\b/.test(c) },
  { name: 'pragma', kinds: ['python'], test: c => /^#\s*pragma:?\s+\S/.test(c) },
  { name: 'linter', kinds: ['python'], test: c => /^#\s*(pylint|fmt|ruff|mypy|flake8|pyright):\s*\S/.test(c) },
  { name: 'language server', kinds: ['yaml'], test: c => /^#\s*yaml-language-server:\s*\S/.test(c) },
  { name: 'action pin', kinds: ['yaml'], test: (c, at) => /\buses:\s*[\w.-]+\/[\w./-]+@[0-9a-f]{40}\s+$/.test(at.before) && /^# [\w.-]+$/.test(c) },
  { name: 'region', kinds: ['gdscript', 'powershell'], test: c => /^#(region|endregion)\b/i.test(c) },
  { name: 'warning-ignore', kinds: ['gdscript'], test: c => /^#\s*warning-ignore(-all)?:\s*\S/.test(c) },
  { name: 'gdtoolkit', kinds: ['gdscript'], test: c => /^#\s*(gdlint|gdformat):\s*\S/.test(c) },
  { name: 'requires', kinds: ['powershell'], test: c => /^#requires\s+-/i.test(c) },
  { name: 'quiet', kinds: ['sed'], test: (c, at) => at.pos === 0 && c === '#n' },
]

function lineEndOf(text: string, from: number): number {
  const n = text.indexOf('\n', from)
  return n === -1 ? text.length : n
}

export function hashCandidate(path: string): boolean {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  return dot <= 0 || KIND_BY_EXTENSION.has(name.slice(dot + 1))
}

export function hashKindOf(path: string, text: string): HashKind | null {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  if (dot > 0) return KIND_BY_EXTENSION.get(name.slice(dot + 1)) ?? null
  if (!text.startsWith('#!')) return null
  const shebang = text.slice(0, lineEndOf(text, 0))
  if (/\bpython[0-9.]*\b/.test(shebang)) return 'python'
  return /\b(ba|da|k|z)?sh\b/.test(shebang) ? 'shell' : null
}

type Frame = { kind: 'cmd' | 'paren' | 'sub' | 'tick' | 'dq' | 'param' | 'arith'; depth: number; cases: number; quoted: boolean }

const COMMAND_WORDS = new Set(['then', 'do', 'else', 'elif', '{', '!', 'if', 'while', 'until', 'time'])

function shellComments(text: string): Range[] {
  const out: Range[] = []
  const stack: Frame[] = [{ kind: 'cmd', depth: 0, cases: 0, quoted: false }]
  const pending: { word: string; tabs: boolean }[] = []
  const n = text.length
  let i = 0
  let wordStart = true
  let commandPosition = true
  let word: string | null = ''
  let wordAtCommand = true
  const push = (kind: Frame['kind'], depth = 0, quoted = false): void => {
    stack.push({ kind, depth, cases: 0, quoted })
  }
  const enterCommand = (kind: 'sub' | 'tick'): void => {
    push(kind)
    wordStart = true
    commandPosition = true
    word = ''
  }
  const endWord = (): void => {
    if (wordStart) return
    const frame = stack[stack.length - 1]!
    if (word === 'case' && wordAtCommand) frame.cases++
    else if (word === 'esac' && frame.cases > 0) frame.cases--
    commandPosition = word !== null && COMMAND_WORDS.has(word)
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
    if (next === '{') {
      const outer = stack[stack.length - 1]!
      push('param', 0, outer.kind === 'dq' || (outer.kind === 'param' && outer.quoted))
      i += 2
      return true
    }
    return false
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
        while (i < n) {
          const end = lineEndOf(text, i)
          const line = text.slice(i, end)
          i = end < n ? end + 1 : end
          if ((doc.tabs ? line.replace(/^\t+/, '') : line) === doc.word) break
        }
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
      out.push({ pos: i, end })
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
      if (delimiter !== '') pending.push({ word: delimiter, tabs })
      i = j
      continue
    }
    beginWord(true, c)
    i++
  }
  return out
}

type QuoteRules = { backslash: (quote: string) => boolean; multiline: boolean }

function quotedComments(text: string, rules: QuoteRules): Range[] {
  const out: Range[] = []
  const n = text.length
  let i = 0
  while (i < n) {
    const c = text[i]!
    if (c === '#') {
      const end = lineEndOf(text, i)
      out.push({ pos: i, end })
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

function powershellComments(text: string): Range[] {
  const out: Range[] = []
  const n = text.length
  let i = 0
  while (i < n) {
    const c = text[i]!
    if (c === '<' && text[i + 1] === '#') {
      const close = text.indexOf('#>', i + 2)
      const end = close === -1 ? n : close + 2
      out.push({ pos: i, end })
      i = end
    } else if (c === '@' && (text[i + 1] === '"' || text[i + 1] === "'") && /^[ \t]*\r?\n/.test(text.slice(i + 2, i + 80))) {
      const close = text.indexOf(`\n${text[i + 1]}@`, i + 2)
      i = close === -1 ? n : close + 3
    } else if (c === '#' && (i === 0 || /[\s;{}(|]/.test(text[i - 1]!))) {
      const end = lineEndOf(text, i)
      out.push({ pos: i, end })
      i = end
    } else if (c === "'") {
      const close = text.indexOf("'", i + 1)
      i = close === -1 ? n : close + 1
    } else if (c === '"') {
      i++
      while (i < n && text[i] !== '"') i += text[i] === '`' ? 2 : 1
      i++
    } else if (c === '`') i += 2
    else i++
  }
  return out
}

function sedComments(text: string): Range[] {
  const out: Range[] = []
  let i = 0
  while (i < text.length) {
    const end = lineEndOf(text, i)
    const indent = /^[ \t]*/.exec(text.slice(i, end))![0].length
    if (text[i + indent] === '#') out.push({ pos: i + indent, end })
    i = end + 1
  }
  return out
}

function yamlComments(text: string): Range[] {
  const out: Range[] = []
  let offset = 0
  let scalar = false
  for (const token of new Lexer().lex(text)) {
    if (token === '\u0002' || token === '\u0018' || token === '\u001f') {
      scalar = token === '\u001f'
      continue
    }
    if (!scalar && token.startsWith('#')) out.push({ pos: offset, end: offset + token.length })
    scalar = false
    offset += token.length
  }
  return out
}

function stringAt(node: unknown, path: string[]): string | null {
  const value = isMap(node) ? node.getIn(path) : undefined
  return typeof value === 'string' ? value : null
}

function runBlockComments(text: string): Range[] {
  if (!/^jobs:/m.test(text)) return []
  const root = parseDocument(text).contents
  const jobs = isMap(root) ? root.get('jobs') : undefined
  if (!isMap(jobs)) return []
  const out: Range[] = []
  for (const pair of jobs.items) {
    const job = pair.value
    if (!isMap(job)) continue
    const runner = stringAt(job, ['runs-on'])
    const platform = runner === null || runner.includes('${{') ? null : /windows/i.test(runner) ? 'pwsh' : 'bash'
    const jobShell = stringAt(job, ['defaults', 'run', 'shell']) ?? stringAt(root, ['defaults', 'run', 'shell']) ?? platform
    const steps = job.get('steps')
    if (!isSeq(steps)) continue
    for (const step of steps.items) {
      if (!isMap(step)) continue
      const run = step.get('run', true)
      const shell = stringAt(step, ['shell']) ?? jobShell
      if (!isScalar(run) || run.type !== Scalar.BLOCK_LITERAL || !run.range || shell === null || !/^(ba)?sh\b/.test(shell)) continue
      const bodyStart = lineEndOf(text, run.range[0]) + 1
      const lines = text.slice(bodyStart, run.range[1]).split('\n')
      const indent = Math.min(...lines.filter(line => line.trim() !== '').map(line => /^ */.exec(line)![0].length))
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
      for (const comment of shellComments(body.join('\n'))) {
        let line = 0
        while (line + 1 < bodyStarts.length && bodyStarts[line + 1]! <= comment.pos) line++
        const shift = sourceStarts[line]! + indent - bodyStarts[line]!
        out.push({ pos: comment.pos + shift, end: comment.end + shift })
      }
    }
  }
  return out
}

const PYTHON_QUOTES: QuoteRules = { backslash: () => true, multiline: false }
const GDSCRIPT_QUOTES: QuoteRules = { backslash: () => true, multiline: true }
const TOML_QUOTES: QuoteRules = { backslash: quote => quote[0] === '"', multiline: false }

const SCANNERS: Record<HashKind, (text: string) => Range[]> = {
  shell: shellComments,
  python: text => quotedComments(text, PYTHON_QUOTES),
  gdscript: text => quotedComments(text, GDSCRIPT_QUOTES),
  toml: text => quotedComments(text, TOML_QUOTES),
  powershell: powershellComments,
  sed: sedComments,
  yaml: yamlComments,
}

function judged(text: string, kind: HashKind, ranges: Range[], embedded: boolean): HashComment[] {
  const rules = HASH_KEEP_RULES.filter(rule => rule.kinds === 'all' || rule.kinds.includes(kind))
  return ranges.map(range => {
    const lineStart = text.lastIndexOf('\n', range.pos - 1) + 1
    let line = 0
    for (let at = text.indexOf('\n'); at !== -1 && at < range.pos; at = text.indexOf('\n', at + 1)) line++
    const comment = text.slice(range.pos, range.end).replace(/\r$/, '')
    const kept = rules.find(rule => rule.test(comment, { pos: range.pos, line, column: range.pos - lineStart, before: text.slice(lineStart, range.pos) }))
    return { pos: range.pos, end: range.end, keep: kept ? kept.name : null, embedded }
  })
}

export function hashComments(path: string, text: string): HashComment[] {
  const kind = hashKindOf(path, text)
  if (kind === null) return []
  const own = judged(text, kind, SCANNERS[kind](text), false)
  if (kind !== 'yaml') return own
  return [...own, ...judged(text, 'shell', runBlockComments(text), true)].sort((a, b) => a.pos - b.pos)
}
