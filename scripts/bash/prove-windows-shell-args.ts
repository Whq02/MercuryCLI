#!/usr/bin/env bun
import '../lib/hermetic.ts'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '../..')
const PATCH = 'scripts/vendor/patches/brush-0.4.0-windows.patch'
const MSYS2 = 'msys2/msys2-runtime msys2-3.6.9 @ 01d6c708f9221334d18ab332621b6d87eb12d37e'
const CYGWIN = 'cygwin/cygwin cygwin-3.6.9 @ daabea98682f3f4bef0044829a8d24226135bb71'
const RUST = 'rust-lang/rust 1.98.1 @ 48a229ceaefd4985c50990b14116b6d856af0985'

let failures = 0
const check = (label: string, ok: boolean, detail = '') => {
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
const show = (value: unknown) => JSON.stringify(value)
const same = (a: string[], b: string[]) => a.length === b.length && a.every((value, i) => value === b[i])

type Flavor = 'msys-2.0.dll' | 'cygwin1.dll'
type World = { files: Record<string, string>; home?: string; users: Record<string, string>; byteLetters?: boolean }
type Reading = { flavor: Flavor; glob: boolean; world: World }
type GChar = { ch: string; protect: boolean }
type Item = { kind: 'char'; ch: string } | { kind: 'all' } | { kind: 'one' } | { kind: 'set'; negate: boolean; members: Array<{ lo: string; hi: string }> }

const NUL = '\0'
let doubledQuotes = 0
const SEPARATORS = ' \t\n\r'
const GLOB_TRIGGERS = '?*["\'(){}'
const LEADING_TRIGGERS = '~@'
const MAX_AT_FILE_LEVEL = 10
const MAXPATHLEN = 8192
const MB_CUR_MAX = 6

const at = (text: string[], i: number) => text[i] ?? NUL
const issep = (ch: string) => ch === NUL || SEPARATORS.includes(ch)
const isquote = (ch: string) => ch === '"' || ch === "'"
const isalpha = (ch: string, world: World) => /^[A-Za-z]$/.test(ch) || (world.byteLetters === true && /^\p{L}$/u.test(ch))
const plain = (g: GChar | undefined, ch: string) => g !== undefined && !g.protect && g.ch === ch

function quoted(cmd: string[], start: number, winshell: boolean, glob: boolean): number {
  const quote = cmd[start]!
  if (!winshell || !glob) {
    cmd.splice(start, 1)
    let p = start
    while (at(cmd, p) !== NUL && cmd[p] !== quote) p++
    if (at(cmd, p) !== NUL) cmd.splice(p, 1)
    return p
  }
  const stops = quote === "'" ? "'" : '\\"'
  let i = start
  while (at(cmd, i) !== NUL && at(cmd, ++i) !== NUL) {
    let p = i
    while (at(cmd, p) !== NUL && !stops.includes(cmd[p]!)) p++
    if (at(cmd, p) === NUL) {
      i = p
      break
    } else if (cmd[p] === '\\') i = p + 1
    else if (quote === '"' && at(cmd, p + 1) === '"') {
      cmd[p] = '\\'
      i = p + 1
    } else {
      i = p + 1
      break
    }
  }
  return i
}

function isDosPath(word: string[], from: number, world: World): boolean {
  if (isalpha(at(word, from), world) && at(word, from + 1) === ':') return true
  return at(word, from) === '\\' && at(word, from + 1) === '\\' && isalpha(at(word, from + 2), world) && word.indexOf('\\', from + 3) !== -1
}

function globtilde(pattern: GChar[], world: World): GChar[] {
  if (!plain(pattern[0], '~')) return pattern
  let p = 1
  let name = ''
  while (pattern[p] !== undefined && !plain(pattern[p], '/')) name += pattern[p++]!.ch
  const home = name === '' ? world.home : world.users[name]
  if (home === undefined) return pattern
  return [...[...home].map(ch => ({ ch, protect: false })), ...pattern.slice(p)]
}

function match(name: string[], from: number, items: Item[], start: number, end: number): boolean {
  let n = from
  let p = start
  while (p < end) {
    const item = items[p++]!
    if (item.kind === 'all') {
      if (p === end) return true
      do {
        if (match(name, n, items, p, end)) return true
      } while (name[n++] !== undefined)
      return false
    }
    if (item.kind === 'one') {
      if (name[n++] === undefined) return false
    } else if (item.kind === 'set') {
      const k = name[n++]
      if (k === undefined) return false
      if (item.members.some(member => member.lo <= k && k <= member.hi) === item.negate) return false
    } else if (name[n++] !== item.ch) return false
  }
  return name[n] === undefined
}

const isSep = (item: Item | undefined) => item !== undefined && item.kind === 'char' && item.ch === '/'
const listable = (path: string) => path === '' || path === './'
const exists = (path: string, world: World) => ['.', '..', '/', world.home, ...Object.values(world.users)].includes(path.length > 1 ? path.replace(/\/+$/, '') : path) || Object.hasOwn(world.files, path.replace(/^\.\//, ''))

function glob3(path: string, items: Item[], start: number, rest: number, paths: string[], world: World): void {
  if (!listable(path)) return
  for (const name of Object.keys(world.files)) {
    const first = items[start]!
    if (name[0] === '.' && !(first.kind === 'char' && first.ch === '.')) continue
    if (match([...name], 0, items, start, rest)) glob2(path + name, items, rest, paths, world)
  }
}

function glob2(path: string, items: Item[], from: number, paths: string[], world: World): void {
  let pathend = path
  let i = from
  for (;;) {
    if (i >= items.length) {
      if (exists(pathend, world)) paths.push(pathend)
      return
    }
    let j = i
    let anymeta = false
    let segment = ''
    while (j < items.length && !isSep(items[j])) {
      const item = items[j++]!
      if (item.kind === 'char') segment += item.ch
      else anymeta = true
    }
    if (anymeta) return glob3(pathend, items, i, j, paths, world)
    pathend += segment
    i = j
    while (isSep(items[i])) {
      pathend += '/'
      i++
    }
  }
}

function glob0(pattern: GChar[], paths: string[], world: World): number {
  const q = globtilde(pattern, world)
  const before = paths.length
  const items: Item[] = []
  let i = 0
  while (i < q.length) {
    const g = q[i++]!
    if (plain(g, '[')) {
      const negate = plain(q[i], '!')
      let j = negate ? i + 1 : i
      let close = j
      while (q[close] !== undefined && !plain(q[close], ']')) {
        if (plain(q[close], '[') && [':', '.', '='].some(kind => plain(q[close + 1], kind))) throw new Error('a class expression is not modelled')
        close++
      }
      if (q[close] === undefined) {
        items.push({ kind: 'char', ch: '[' })
        continue
      }
      if (close === j) throw new Error('an empty set is not modelled')
      const members: Array<{ lo: string; hi: string }> = []
      let c = q[j++]!
      do {
        if (plain(q[j], '-') && !plain(q[j + 1], ']')) {
          members.push({ lo: c.ch, hi: q[j + 1]!.ch })
          j += 2
        } else members.push({ lo: c.ch, hi: c.ch })
      } while (!plain((c = q[j++]!), ']'))
      items.push({ kind: 'set', negate, members })
      i = j
    } else if (plain(g, '?')) items.push({ kind: 'one' })
    else if (plain(g, '*')) {
      if (items.at(-1)?.kind !== 'all') items.push({ kind: 'all' })
    } else items.push({ kind: 'char', ch: g.ch })
  }
  if (items.length > 0) glob2('', items, 0, paths, world)
  if (paths.length === before) {
    paths.push(pattern.map(g => g.ch).join(''))
    return 0
  }
  const found = paths.splice(before).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  paths.push(...found)
  return 0
}

function globexp2(ptr: number, pattern: GChar[], paths: string[], world: World): number {
  const skipSet = (open: number): number => {
    let p = open + 1
    while (pattern[p] !== undefined && !plain(pattern[p], ']')) {
      if (plain(pattern[p], '[') && [':', '.', '='].some(kind => plain(pattern[p + 1], kind))) throw new Error('a class expression is not modelled')
      p++
    }
    return pattern[p] === undefined ? open : p
  }
  const head = pattern.slice(0, ptr)
  let depth = 0
  let pe = ptr + 1
  for (; pattern[pe] !== undefined; pe++) {
    if (plain(pattern[pe], '[')) pe = skipSet(pe)
    else if (plain(pattern[pe], '{')) depth++
    else if (plain(pattern[pe], '}')) {
      if (depth === 0) break
      depth--
    }
  }
  if (depth !== 0 || pattern[pe] === undefined) return glob0(head, paths, world)
  depth = 0
  let pl = ptr + 1
  for (let pm = ptr + 1; pm <= pe; pm++) {
    if (plain(pattern[pm], '[')) pm = skipSet(pm)
    else if (plain(pattern[pm], '{')) depth++
    else if (plain(pattern[pm], '}') && depth > 0) depth--
    else if (plain(pattern[pm], '}') || (plain(pattern[pm], ',') && depth === 0)) {
      globexp1([...head, ...pattern.slice(pl, pm), ...pattern.slice(pe + 1)], paths, world)
      pl = pm + 1
    }
  }
  return 0
}

function globexp1(pattern: GChar[], paths: string[], world: World): number {
  if (pattern.length === 2 && plain(pattern[0], '{') && plain(pattern[1], '}')) return glob0(pattern, paths, world)
  const brace = pattern.findIndex(g => plain(g, '{'))
  return brace === -1 ? glob0(pattern, paths, world) : globexp2(brace, pattern, paths, world)
}

function glob(pattern: string[], world: World): string[] | null {
  const buf: GChar[] = []
  let i = 0
  while (MAXPATHLEN - 1 - buf.length >= MB_CUR_MAX) {
    let protect = false
    if (at(pattern, i) === '\\') {
      if (at(pattern, ++i) === NUL) {
        buf.push({ ch: '\\', protect: true })
        continue
      }
      protect = true
    }
    if (at(pattern, i) === NUL) break
    buf.push({ ch: pattern[i++]!, protect })
  }
  const paths: string[] = []
  return globexp1(buf, paths, world) === 0 ? paths : null
}

function globify(word: string[], argv: string[], reading: Reading): boolean {
  if (word[0] !== '~' && !word.some(ch => GLOB_TRIGGERS.includes(ch))) return false
  let dosSpec = isDosPath(word, 0, reading.world)
  if (!dosSpec && isquote(at(word, 0)) && at(word, 1) !== NUL && at(word, 2) !== NUL) dosSpec = isDosPath(word, 1, reading.world)
  const pattern: string[] = []
  for (let s = 0; at(word, s) !== NUL; s++) {
    if (!isquote(word[s]!)) {
      if (dosSpec && word[s] === '\\') pattern.push('\\')
      pattern.push(word[s]!)
      continue
    }
    const quote = word[s]!
    while (at(word, ++s) !== NUL && word[s] !== quote) {
      const escapes = word[s] === '\\' && (at(word, s + 1) === quote || at(word, s + 1) === '\\')
      if (reading.flavor === 'msys-2.0.dll' ? escapes : !dosSpec && escapes) s++
      pattern.push('\\', word[s]!)
    }
    if (at(word, s) === NUL) break
  }
  const paths = glob(pattern, reading.world)
  if (paths === null || paths.length === 0) return false
  argv.push(...paths)
  return true
}

function buildArgv(line: string, reading: Reading): string[] {
  const winshell = reading.flavor === 'msys-2.0.dll' ? true : reading.glob
  let cmd = [...line]
  let i = 0
  let nesting = 0
  const argv: string[] = []
  while (at(cmd, i) !== NUL) {
    if (issep(cmd[i]!)) {
      i++
      continue
    }
    const word = i
    let sawquote = -1
    while (at(cmd, i) !== NUL) {
      if (cmd[i] !== '"' && (!winshell || cmd[i] !== "'")) i++
      else {
        sawquote = i
        i = quoted(cmd, i, winshell && argv.length > 0 && cmd[word] !== '@', reading.glob)
      }
      if (issep(at(cmd, i))) break
    }
    const text = cmd.slice(word, i)
    if (at(cmd, i) !== NUL) i++
    if (argv.length > 0 && sawquote !== word && text[0] === '@') {
      if (++nesting > MAX_AT_FILE_LEVEL) throw new Error(`Too many levels of nesting for ${text.join('')}`)
      const file = reading.world.files[text.slice(1).join('')]
      if (file !== undefined) {
        cmd = [...file, ' ', ...cmd.slice(i)]
        i = 0
        continue
      }
    }
    if (!reading.glob || argv.length === 0 || !globify(text, argv, reading)) argv.push(text.join(''))
  }
  return argv
}

function msArgv(line: string): string[] {
  const units = [...line]
  const argv: string[] = []
  let i = 0
  let inQuotes = false
  let cur = ''
  while (i < units.length) {
    const w = units[i++]!
    if (w === '"') inQuotes = !inQuotes
    else if ((w === ' ' || w === '\t') && !inQuotes) break
    else cur += w
  }
  while (units[i] === ' ' || units[i] === '\t') i++
  argv.push(cur)
  cur = ''
  inQuotes = false
  while (i < units.length) {
    const w = units[i++]!
    if ((w === ' ' || w === '\t') && !inQuotes) {
      argv.push(cur)
      cur = ''
      while (units[i] === ' ' || units[i] === '\t') i++
    } else if (w === '\\') {
      let count = 1
      while (units[i] === '\\') {
        count++
        i++
      }
      if (units[i] === '"') {
        cur += '\\'.repeat(Math.floor(count / 2))
        if (count % 2 === 1) {
          i++
          cur += '"'
        }
      } else cur += '\\'.repeat(count)
    } else if (w === '"' && inQuotes) {
      if (units[i] === '"') {
        doubledQuotes++
        cur += '"'
        i++
      } else if (i < units.length) inQuotes = false
      else break
    } else if (w === '"') inQuotes = true
    else cur += w
  }
  if (cur !== '' || inQuotes) argv.push(cur)
  return argv
}

function stdArg(arg: string): string {
  const quote = arg === '' || /[ \t]/.test(arg)
  let out = quote ? '"' : ''
  let backslashes = 0
  for (const x of arg) {
    if (x === '\\') backslashes++
    else {
      if (x === '"') out += '\\'.repeat(backslashes + 1)
      backslashes = 0
    }
    out += x
  }
  return quote ? out + '\\'.repeat(backslashes) + '"' : out
}

function posixArg(word: string): string {
  const chars = [...word]
  const takenAsItStands = word !== '' && !LEADING_TRIGGERS.includes(chars[0]!) && !chars.some(ch => (SEPARATORS + GLOB_TRIGGERS).includes(ch))
  if (takenAsItStands) return word
  const drive = chars.length > 1 && chars[1] === ':' && /^\p{Alphabetic}$/u.test(chars[0]!)
  let written = drive ? `${chars[0]}"` : '"'
  let backslashes = 0
  for (const c of drive ? chars.slice(1) : chars) {
    if (c === '\\') {
      backslashes++
      continue
    }
    if (backslashes > 1 || c === '"') backslashes *= 2
    written += '\\'.repeat(backslashes)
    backslashes = 0
    written += c === '"' ? '\\"' : c
  }
  return `${written}${'\\'.repeat(backslashes * 2)}"`
}

const PROGRAM = 'C:\\Program Files\\Git\\usr\\bin\\echo.exe'
const lineOf = (write: (word: string) => string, words: string[]) => `"${PROGRAM}"${words.map(word => ` ${write(word)}`).join('')}`
const BOX: World = { files: { 'a.ts': '', 'b.ts': '', 'list.txt': 'x y\n' }, home: '/home/model', users: { user: '/home/user' } }
const msys = (line: string, world = BOX) => buildArgv(line, { flavor: 'msys-2.0.dll', glob: true, world }).slice(1)
const cygwin = (line: string, world = BOX) => buildArgv(line, { flavor: 'cygwin1.dll', glob: true, world }).slice(1)
const microsoft = (line: string) => msArgv(line).slice(1)
const attempt = (read: () => string[]): string[] => {
  try {
    return read()
  } catch (error) {
    return [`<${String(error)}>`]
  }
}

type Row = { word: string; written: string; today?: string[]; cygwin?: string[] }
const TABLE: Row[] = [
  { word: '"description":"effort-probe"', written: '"\\"description\\":\\"effort-probe\\""', today: ['\\description":"effort-probe" end'] },
  { word: '*.ts', written: '"*.ts"', today: ['a.ts', 'b.ts', 'end'] },
  { word: '@list.txt', written: '"@list.txt"', today: ['x', 'y', 'end'] },
  { word: 'p q"r', written: '"p q\\"r"' },
  { word: 'a b\\\\c', written: '"a b\\\\\\\\c"', today: ['a b\\c', 'end'] },
  { word: '', written: '""' },
  { word: 'a b', written: '"a b"' },
  { word: 'a\tb', written: '"a\tb"' },
  { word: ' ', written: '" "' },
  { word: 'dir\\', written: 'dir\\' },
  { word: 'my dir\\', written: '"my dir\\\\"' },
  { word: 'a b\\\\', written: '"a b\\\\\\\\"' },
  { word: '\\\\server\\share', written: '\\\\server\\share' },
  { word: '\\\\server\\share dir', written: '"\\\\\\\\server\\share dir"', today: ['\\server\\share dir', 'end'], cygwin: ['\\\\server\\share dir', 'end'] },
  { word: 'C:\\Program Files\\x', written: 'C":\\Program Files\\x"' },
  { word: 'C:\\\\x', written: 'C:\\\\x' },
  { word: 'C:\\dir\\', written: 'C:\\dir\\' },
  { word: 'C:\\\\x y', written: 'C":\\\\\\\\x y"', today: ['C:\\x y', 'end'], cygwin: ['C:\\\\x y', 'end'] },
  { word: 'C:\\my dir\\', written: 'C":\\my dir\\\\"', cygwin: ['C:\\my dir\\\\', 'end'] },
  { word: 'C:\\a "b"', written: 'C":\\a \\"b\\""', cygwin: ['C:\\a \\b\\', 'end'] },
  { word: 'C:', written: 'C:' },
  { word: 's:a b:', written: 's":a b:"' },
  { word: 'a\\\\b', written: 'a\\\\b' },
  { word: 'a\\b c', written: '"a\\b c"' },
  { word: '\\', written: '\\' },
  { word: "'single'", written: '"\'single\'"', today: ['single', 'end'] },
  { word: "it's", written: '"it\'s"', today: ['its end'] },
  { word: '$HOME', written: '$HOME' },
  { word: '%VAR%', written: '%VAR%' },
  { word: '^', written: '^' },
  { word: 'a\nb', written: '"a\nb"', today: ['a', 'b', 'end'] },
  { word: 'a\rb', written: '"a\rb"', today: ['a', 'b', 'end'] },
  { word: '~user', written: '"~user"', today: ['/home/user', 'end'] },
  { word: '~', written: '"~"', today: ['/home/model', 'end'] },
  { word: 'a~b', written: 'a~b' },
  { word: '{a,b}', written: '"{a,b}"', today: ['a', 'b', 'end'] },
  { word: '{print $1}', written: '"{print $1}"' },
  { word: '(x)', written: '"(x)"' },
  { word: '[ab]', written: '"[ab]"' },
  { word: '[ab].ts', written: '"[ab].ts"', today: ['a.ts', 'b.ts', 'end'] },
  { word: '*', written: '"*"', today: ['a.ts', 'b.ts', 'list.txt', 'end'] },
  { word: '?', written: '"?"' },
  { word: '?.ts', written: '"?.ts"', today: ['a.ts', 'b.ts', 'end'] },
  { word: '--include=*.ts', written: '"--include=*.ts"' },
  { word: '@', written: '"@"' },
  { word: 'a@b', written: 'a@b' },
  { word: '-n', written: '-n' },
  { word: 'naïve', written: 'naïve' },
  { word: '日本語', written: '日本語' },
  { word: 'é t', written: '"é t"' },
  { word: 'é:x y', written: 'é":x y"' },
  { word: '"', written: '"\\""', today: ['\\ end'] },
  { word: '\\"', written: '"\\\\\\""', today: ['\\\\ end'] },
  { word: '\\\\"', written: '"\\\\\\\\\\""', today: ['\\\\\\ end'] },
  { word: 's/"a"/"b"/', written: '"s/\\"a\\"/\\"b\\"/"', today: ['s/\\a"/"b"/ end'] },
  { word: '"key":', written: '"\\"key\\":"', today: ['\\key": end'] },
]
const wanted = (row: Row) => [row.word, 'end']

const patch = readFileSync(join(ROOT, PATCH), 'utf8')
const added = patch.split('\n').filter(line => line.startsWith('+') && !line.startsWith('+++')).map(line => line.slice(1))
const fnStart = added.indexOf('fn posix_runtime_arg(word: &str) -> String {')
const fnEnd = fnStart === -1 ? -1 : added.indexOf('}', fnStart)
const rustWriter = fnStart === -1 || fnEnd === -1 ? null : added.slice(fnStart, fnEnd + 1).join('\n')
const routed = patch.includes('+                Some(word) => cmd.raw_arg(posix_runtime_arg(word)),')
const engine = rustWriter !== null && routed ? posixArg : stdArg

const unescapeRust = (text: string) => text.replace(/\\(u\{([0-9a-fA-F]+)\}|.)/g, (_, body: string, hex?: string) => (hex ? String.fromCodePoint(parseInt(hex, 16)) : ({ n: '\n', t: '\t', r: '\r' }[body] ?? body)))
const rustChars = (call: string): string[] => {
  const list = rustWriter?.match(new RegExp(`word\\.${call}\\(\\[([^\\]]*)\\]\\)`))?.[1] ?? ''
  return [...list.matchAll(/'(\\.|[^'\\])'/g)].map(found => unescapeRust(found[1]!))
}
const sameSet = (a: string[], b: string[]) => a.length === b.length && new Set(a).size === a.length && a.every(ch => b.includes(ch))
const RUST_ROW = /^\s+\((?:r#"(.*?)"#|"((?:[^"\\]|\\.)*)"), (?:r#"(.*?)"#|"((?:[^"\\]|\\.)*)")\),$/
const testStart = added.findIndex(line => line.includes('fn posix_runtime_words_are_written_for_that_runtime()'))
const rustTable =
  testStart === -1
    ? []
    : added
        .slice(testStart, added.indexOf('    }', testStart))
        .map(line => RUST_ROW.exec(line))
        .filter(found => found !== null)
        .map(found => ({ word: found[1] ?? unescapeRust(found[2]!), written: found[3] ?? unescapeRust(found[4]!) }))

function corpusOf(alphabet: string[], lengths: number[]): string[] {
  const out: string[] = []
  const grow = (prefix: string, left: number): void => {
    if (left === 0) out.push(prefix)
    else for (const ch of alphabet) grow(prefix + ch, left - 1)
  }
  for (const length of lengths) grow('', length)
  return out
}
const CORPUS = [...corpusOf(['a', 'C', ':', ' ', '"', "'", '\\', '*', '@', '~', '{', '}', '\n', 'é'], [0, 1, 2, 3, 4]), ...corpusOf(['a', ':', ' ', '"', '\\', "'", '*'], [5, 6])]
const CORPUS_WORLD: World = { files: { a: 'x y', aa: '', C: '', 'a.ts': '' }, home: '/home/model', users: { a: '/home/a' } }

console.log(`readers: winsup/cygwin/dcrt0.cc (build_argv, quoted, globify, insert_file) and glob.cc of ${MSYS2}, the runtime of Git for Windows 2.55, and of ${CYGWIN}; library/std/src/sys/args/windows.rs (parse_lp_cmd_line) of ${RUST}`)
console.log(`writers: append_arg and make_command_line of that standard library, and what ${PATCH} hands a program of the POSIX runtime: ${engine === posixArg ? 'posix_runtime_arg' : 'the standard arguments, it has no writer of its own'}`)

console.log('the writer in the patch')
check('the patch hands a program of the POSIX runtime arguments written by posix_runtime_arg', engine === posixArg)
if (rustWriter !== null) {
  check(
    'a word is left as it stands exactly when the runtime takes it as it stands: no separator (winsup.h 137, issep " \\t\\n\\r"), none of globify\'s ?*["\'(){} (dcrt0.cc 209), no leading ~ (209) and no leading @ (351), as those files stand at the commit named above',
    sameSet(rustChars('contains'), [...SEPARATORS, ...GLOB_TRIGGERS]) && sameSet(rustChars('starts_with'), [...LEADING_TRIGGERS]),
    `contains ${show(rustChars('contains'))} starts_with ${show(rustChars('starts_with'))}`,
  )
  check(`the patch's own Rust test holds this table, ${TABLE.length} rows word for word`, rustTable.length === TABLE.length && TABLE.every((row, i) => rustTable[i]!.word === row.word && rustTable[i]!.written === row.written), `${rustTable.length} rows in the patch`)
  const unlike = TABLE.find(row => posixArg(row.word) !== row.written)
  check('the port of the writer writes every row as the table holds it', unlike === undefined, unlike === undefined ? '' : `${show(unlike.word)} is written ${show(posixArg(unlike.word))}`)
  const rustc = [join(homedir(), '.cargo/bin', process.platform === 'win32' ? 'rustc.exe' : 'rustc'), 'rustc'].find(bin => spawnSync(bin, ['--version'], { encoding: 'utf8' }).status === 0)
  if (!rustc) console.log('[SKIP] the Rust text of the writer is not compiled here (no rustc): the port stands on the table the patch holds')
  else {
    const scratch = mkdtempSync(join(tmpdir(), 'windows-shell-args-'))
    try {
      const source = join(scratch, 'writer.rs')
      const exe = join(scratch, process.platform === 'win32' ? 'writer.exe' : 'writer')
      writeFileSync(source, `${rustWriter}
fn main() {
    use std::io::{Read, Write};
    let mut input = String::new();
    std::io::stdin().read_to_string(&mut input).unwrap();
    let mut output = String::new();
    for line in input.lines() {
        let bytes = (1..line.len()).step_by(2).map(|i| u8::from_str_radix(&line[i..i + 2], 16).unwrap()).collect::<Vec<_>>();
        output.push('=');
        for byte in posix_runtime_arg(&String::from_utf8(bytes).unwrap()).bytes() {
            output.push_str(&format!("{byte:02x}"));
        }
        output.push('\\n');
    }
    std::io::stdout().write_all(output.as_bytes()).unwrap();
}
`)
      const compile = spawnSync(rustc, ['--edition', '2024', source, '-o', exe], { cwd: scratch, encoding: 'utf8' })
      check('the Rust text of the writer, taken from the patch, compiles on this host', compile.status === 0, `${compile.stdout}${compile.stderr}`.trim())
      if (compile.status === 0) {
        const all = [...TABLE.map(row => row.word), ...CORPUS]
        const hex = (text: string) => Buffer.from(text, 'utf8').toString('hex')
        const run = spawnSync(exe, [], { cwd: scratch, input: all.map(word => `=${hex(word)}\n`).join(''), encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
        const lines = run.stdout.split('\n').filter(Boolean)
        const differs = all.findIndex((word, i) => lines[i] !== `=${hex(posixArg(word))}`)
        check(`the Rust text writes all ${all.length} words, the table and the corpus, as the port does`, run.status === 0 && lines.length === all.length && differs === -1, differs === -1 ? `rc=${run.status}` : `${show(all[differs])}: Rust ${show(Buffer.from((lines[differs] ?? '=').slice(1), 'hex').toString('utf8'))}, the port ${show(posixArg(all[differs]!))}`)
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  }
}

console.log('the six lines the Windows box read by hand (FRC2W-U-93), from the standard arguments as msys-2.0.dll reads them')
const box = (label: string, words: string[], seen: string[]) => {
  const read = attempt(() => msys(lineOf(stdArg, words)))
  check(label, same(read, seen), show(read))
}
box('1: echo.exe receives: \\description":"effort-probe"', ['echo.exe receives:', '"description":"effort-probe"'], ['echo.exe receives:', '\\description":"effort-probe"'])
box('2: A: a.ts b.ts', ['A:', '*.ts'], ['A:', 'a.ts', 'b.ts'])
box('3: B: x y', ['B:', '@list.txt'], ['B:', 'x', 'y'])
box('4: C: p q"r, as given', ['C:', 'p q"r'], ['C:', 'p q"r'])
box('5: D: a b\\c, one backslash', ['D:', 'a b\\\\c'], ['D:', 'a b\\c'])
box("6: find . -name '*.ts' is handed b.ts after its expression (paths must precede expression: 'b.ts')", ['.', '-name', '*.ts'], ['.', '-name', 'a.ts', 'b.ts'])
box("6: grep -c 'x' '@list.txt' is handed x and y as files (grep: x: No such file or directory)", ['-c', 'x', '@list.txt'], ['-c', 'x', 'x', 'y'])
box('6: grep -c \'"description":"effort-probe"\' <file> is handed the pattern and the file as one word, reads its standard input and counts 0', ['-c', '"description":"effort-probe"', 'C:\\Temp\\record.meta.json'], ['-c', '\\description":"effort-probe" C:\\Temp\\record.meta.json'])

console.log("Microsoft's runtime: the standard arguments, which the patch leaves to every program outside the POSIX runtime and to every batch file")
doubledQuotes = 0
for (const row of TABLE) {
  const read = attempt(() => microsoft(lineOf(stdArg, wanted(row))))
  check(`a program of Microsoft's runtime receives ${show(row.word)}`, same(read, wanted(row)), `written ${show(stdArg(row.word))}${same(read, wanted(row)) ? '' : `, read ${show(read)}`}`)
}
const msChanged = CORPUS.filter(word => !same(attempt(() => microsoft(lineOf(stdArg, [word, 'end']))), [word, 'end']))
check(`Microsoft's reader reads all ${CORPUS.length} words of the corpus as given`, msChanged.length === 0, msChanged.length === 0 ? '' : `${msChanged.length} changed, the first ${show(msChanged[0])}`)
check('no line written made that reader apply its rule for two quotes inside quotes, the one place where CommandLineToArgvW and the C runtime before 2008 are known to read otherwise', doubledQuotes === 0, `${doubledQuotes} times`)

console.log('the POSIX runtime: what the patch hands such a program, as msys-2.0.dll and cygwin1.dll read it')
for (const row of TABLE) {
  const line = lineOf(engine, wanted(row))
  const [m, c] = [attempt(() => msys(line)), attempt(() => cygwin(line))]
  const ok = same(m, wanted(row)) && same(c, wanted(row))
  check(`a program of the POSIX runtime receives ${show(row.word)}`, ok, `written ${show(engine(row.word))}, msys-2.0.dll reads ${show(m)}, cygwin1.dll reads ${show(c)}`)
}
const readers: Array<[string, Reading]> = [
  ['msys-2.0.dll', { flavor: 'msys-2.0.dll', glob: true, world: CORPUS_WORLD }],
  ['cygwin1.dll', { flavor: 'cygwin1.dll', glob: true, world: CORPUS_WORLD }],
  ['cygwin1.dll in a locale whose letters are single bytes', { flavor: 'cygwin1.dll', glob: true, world: { ...CORPUS_WORLD, byteLetters: true } }],
]
for (const [name, reading] of readers) {
  const changed = CORPUS.filter(word => !same(attempt(() => buildArgv(lineOf(engine, [word, 'end']), reading).slice(1)), [word, 'end']))
  check(`${name} reads all ${CORPUS.length} words of the corpus as given`, changed.length === 0, changed.length === 0 ? '' : `${changed.length} changed, the first ${show(changed[0])}`)
}

console.log('before the patch such a program was handed the standard arguments: what the two DLLs make of them')
let unchanged = 0
for (const row of TABLE) {
  const line = lineOf(stdArg, wanted(row))
  const [m, c] = [attempt(() => msys(line)), attempt(() => cygwin(line))]
  const [wantM, wantC] = [row.today ?? wanted(row), row.cygwin ?? row.today ?? wanted(row)]
  if (row.today === undefined && row.cygwin === undefined && same(m, wantM) && same(c, wantC)) unchanged++
  else check(`the standard arguments for ${show(row.word)}: msys-2.0.dll reads ${show(wantM)}, cygwin1.dll reads ${show(wantC)}`, same(m, wantM) && same(c, wantC), same(m, wantM) && same(c, wantC) ? '' : `the port: msys-2.0.dll ${show(m)}, cygwin1.dll ${show(c)}`)
}
const changedRows = TABLE.filter(row => row.today !== undefined || row.cygwin !== undefined).length
check(`the other ${TABLE.length - changedRows} rows arrive as given under the standard arguments too`, unchanged === TABLE.length - changedRows, `${unchanged}`)

console.log('what the readers themselves limit')
const KEPT = MAXPATHLEN - MB_CUR_MAX
const plainLong = 'x'.repeat(9000)
const enclosedLong = `x y${'x'.repeat(8997)}`
check('a word of 9,000 characters with no trigger arrives whole, by the standard arguments and by the patch: it never reaches glob', [stdArg, engine].every(write => same(msys(lineOf(write, [plainLong, 'end'])), [plainLong, 'end']) && same(cygwin(lineOf(write, [plainLong, 'end'])), [plainLong, 'end'])))
check(`an enclosed word of 9,000 characters arrives cut after ${KEPT}, by the standard arguments and by the patch alike: glob's own buffer (glob.cc 102 MAXPATHLEN 8192; 242 and 257, the copy stops MB_CUR_MAX short of its end)`, [stdArg, engine].every(write => same(msys(lineOf(write, [enclosedLong, 'end'])), [enclosedLong.slice(0, KEPT), 'end'])))
const noglob = (write: (word: string) => string, word: string) => attempt(() => buildArgv(lineOf(write, [word, 'end']), { flavor: 'msys-2.0.dll', glob: false, world: BOX }).slice(1))
check('with MSYS=noglob the runtime strips quotes and knows no escape (dcrt0.cc 162): a quote inside an enclosed word cannot be given, by the standard arguments or by this rule', same(noglob(stdArg, 'p q"r'), ['p q\\r end']) && same(noglob(posixArg, 'p q"r'), ['p q\\r end']), `${show(noglob(stdArg, 'p q"r'))} ${show(noglob(posixArg, 'p q"r'))}`)
check('with MSYS=noglob a run this rule doubled stays doubled: a b\\\\c arrives with four backslashes where the standard arguments gave two; a single backslash and a word left as it stands arrive as given', same(noglob(posixArg, 'a b\\\\c'), ['a b\\\\\\\\c', 'end']) && same(noglob(stdArg, 'a b\\\\c'), ['a b\\\\c', 'end']) && same(noglob(posixArg, 'C:\\my dir\\x'), ['C:\\my dir\\x', 'end']) && same(noglob(posixArg, 'C:\\\\x'), ['C:\\\\x', 'end']), `${show(noglob(posixArg, 'a b\\\\c'))} ${show(noglob(posixArg, 'C:\\my dir\\x'))}`)

console.log(failures === 0 ? 'PASS Windows shell arguments reach both runtimes as the shell words' : `FAIL Windows shell arguments (${failures})`)
process.exit(failures === 0 ? 0 : 1)
