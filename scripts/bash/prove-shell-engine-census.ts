#!/usr/bin/env bun
import { plugin } from 'bun'
import '../lib/hermetic.ts'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { ROOT, findVendoredBrush } from './shell-engine-parity.ts'

plugin({
  name: 'stub-color-diff-napi',
  setup(build) {
    build.module('color-diff-napi', () => ({
      loader: 'object',
      exports: { ColorDiff: class {}, ColorFile: class {}, getSyntaxTheme: () => ({}) },
    }))
  },
})

process.chdir(ROOT)
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

const args = process.argv.slice(2)
let brushArg: string | undefined
let out: string | undefined
let print = false
for (let i = 0; i < args.length; i++) {
  const arg = args[i] as string
  if (arg === '--brush') brushArg = args[++i]
  else if (arg === '--out') out = args[++i]
  else if (arg === '--print') print = true
}


interface Sample {
  command: string
  source: string
}

const SKIP_DIRS = new Set(['node_modules', '.out', 'vendor', 'dist'])
function walk(dir: string, into: string[]): void {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue
    const full = join(dir, entry)
    let stats
    try {
      stats = statSync(full)
    } catch {
      continue
    }
    if (stats.isDirectory()) walk(full, into)
    else if (/\.(ts|tsx|js|mjs|json|jsonl|txt|md)$/.test(entry)) into.push(full)
  }
}

const TS_TOOL_USE = /name:\s*['"]Bash['"][^}]*?input:\s*\{\s*command:\s*(['"`])((?:\\.|(?!\1)[\s\S])*)\1/g
const JSON_COMMAND_FIRST = /"command":\s*"((?:\\.|[^"\\])*)"\s*\}\s*,?\s*"name":\s*"Bash"/g
const JSON_NAME_FIRST = /"name":\s*"Bash"[^}]*?"input":\s*\{[^}]*?"command":\s*"((?:\\.|[^"\\])*)"/g

function unescapeTs(text: string, quote: string): string | null {
  if (quote === '`' && /\$\{/.test(text)) return null
  return text.replace(/\\(n|t|r|\\|'|"|`|0)/g, (_m, c: string) => ({ n: '\n', t: '\t', r: '\r', '\\': '\\', "'": "'", '"': '"', '`': '`', '0': '\0' })[c] as string)
}
function unescapeJson(text: string): string | null {
  try {
    return JSON.parse(`"${text}"`) as string
  } catch {
    return null
  }
}

function collectCorpus(): { samples: Sample[]; files: number; templated: number } {
  const files: string[] = []
  walk(join(ROOT, 'scripts'), files)
  const seen = new Map<string, Sample>()
  let templated = 0
  const add = (command: string | null, source: string): void => {
    if (command === null) {
      templated++
      return
    }
    const trimmed = command.trim()
    if (trimmed === '' || trimmed.includes('\0')) return
    if (!seen.has(trimmed)) seen.set(trimmed, { command: trimmed, source })
  }
  for (const file of files) {
    const text = readFileSync(file).toString('utf8')
    const source = relative(ROOT, file)
    if (/\.(json|jsonl)$/.test(file)) {
      for (const match of text.matchAll(JSON_COMMAND_FIRST)) add(unescapeJson(match[1] as string), source)
      for (const match of text.matchAll(JSON_NAME_FIRST)) add(unescapeJson(match[1] as string), source)
      continue
    }
    for (const match of text.matchAll(TS_TOOL_USE)) add(unescapeTs(match[2] as string, match[1] as string), source)
  }
  const analysis = join(ROOT, 'scripts', 'decisions', 'command-analysis-corpus.json')
  if (existsSync(analysis)) {
    const parsed = JSON.parse(readFileSync(analysis, 'utf8')) as Record<string, Record<string, unknown>>
    for (const sectionName of ['split', 'redirections', 'tokens']) {
      for (const key of Object.keys(parsed[sectionName] ?? {})) add(key, `scripts/decisions/command-analysis-corpus.json#${sectionName}`)
    }
  }
  return { samples: [...seen.values()], files: files.length, templated }
}


const CONSTRUCTS: Array<[string, RegExp]> = [
  ['pipe', /(?<!\|)\|(?!\|)/],
  ['and-list', /&&/],
  ['or-list', /\|\|/],
  ['sequence', /;/],
  ['redirect', /(?<!<)>{1,2}|(?<![<>])\d?>[|&]?/],
  ['stdin-redirect', /(?<![<>])<(?![<(])/],
  ['heredoc', /<<-?\s*['"\\]?[A-Za-z_]/],
  ['here-string', /<<</],
  ['subshell', /\(\s*[^)]*\)/],
  ['command-substitution', /\$\(|`/],
  ['parameter-expansion', /\$\{/],
  ['variable', /\$[A-Za-z_]/],
  ['special-parameter', /\$[?$!#@*0-9-]/],
  ['glob', /(^|[\s"'])[^\s"']*[*?][^\s"']*|\[[^\]]+\]/],
  ['brace-expansion', /\{[^{}\s]*,[^{}\s]*\}/],
  ['arithmetic', /\$\(\(/],
  ['control-flow', /\b(for|while|until|if|case|select)\b/],
  ['function', /\b\w+\s*\(\)\s*\{|\bfunction\b/],
  ['background', /(?<!&)&(?![&>])\s*(;|$)/],
  ['env-assignment', /^[A-Za-z_][A-Za-z0-9_]*=\S*\s+\S/],
  ['single-quotes', /'/],
  ['double-quotes', /"/],
  ['ansi-c-quoting', /\$'/],
  ['multi-line', /\n/],
  ['extglob', /[?*+@!]\(/],
  ['process-substitution', /[<>]\(/],
  ['escape', /\\/],
]
const constructsOf = (command: string): string[] => CONSTRUCTS.filter(([, re]) => re.test(command)).map(([name]) => name)


interface EngineSpec {
  name: string
  bin: string
  parseArgs: string[]
  execArgs: string[]
}
const BASH = '/bin/bash'
const ZSH = '/bin/zsh'
const brushBin = brushArg ?? findVendoredBrush(ROOT) ?? undefined
const engines: EngineSpec[] = []
if (existsSync(BASH)) engines.push({ name: 'bash', bin: BASH, parseArgs: ['-n', '-c'], execArgs: ['-c'] })
if (brushBin && existsSync(brushBin)) engines.push({ name: 'brush', bin: brushBin, parseArgs: ['--norc', '--noprofile', '--disable-color', '-n', '-c'], execArgs: ['--norc', '--noprofile', '--disable-color', '-c'] })
if (existsSync(ZSH)) engines.push({ name: 'zsh', bin: ZSH, parseArgs: ['-n', '-c'], execArgs: ['-c'] })

const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'shell-engine-census-')))
mkdirSync(join(SCRATCH, 'home'))
writeFileSync(join(SCRATCH, 'report.md'), 'a fixture file the read-only commands can see\n')
const minimalEnv = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: join(SCRATCH, 'home'), TERM: 'dumb', LANG: 'C', LC_ALL: 'C' }

interface RunResult {
  code: number | null
  signal: string | null
  stdout: string
  stderr: string
  ms: number
}
function runEngine(engine: EngineSpec, mode: 'parse' | 'exec', command: string): RunResult {
  const started = Date.now()
  const result = spawnSync(engine.bin, [...(mode === 'parse' ? engine.parseArgs : engine.execArgs), command], {
    cwd: SCRATCH,
    env: minimalEnv,
    encoding: 'utf8',
    timeout: 8_000,
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 8 * 1024 * 1024,
  })
  return { code: result.status, signal: result.signal ?? null, stdout: result.stdout ?? '', stderr: result.stderr ?? '', ms: Date.now() - started }
}

const KNOWN_GAPS: Array<[string, RegExp]> = [
  ['select (unsupported upstream)', /\bselect\b/],
  ['wait -n (unsupported upstream)', /\bwait\s+-n\b/],
  ['disown (unsupported upstream)', /\bdisown\b/],
  ['$! (unreliable upstream)', /\$!/],
  ['signal traps (in progress upstream)', /\btrap\b[^\n;]*\b(INT|TERM|HUP|USR1|USR2|SIG[A-Z]+)\b/],
]
const knownGapOf = (command: string): string | null => KNOWN_GAPS.find(([, re]) => re.test(command))?.[0] ?? null


const { checkReadOnlyConstraints } = await import('../../src/tools/BashTool/readOnlyValidation.ts')

interface CensusRow {
  command: string
  source: string
  constructs: string[]
  readOnly: boolean
  executed: boolean
  parse: Record<string, number | null>
  exec: Record<string, RunResult | undefined>
  verdict: 'same' | 'mismatch' | 'known-gap' | 'control-only'
  detail: string
}

const { samples, files, templated } = collectCorpus()
section('§1 the corpus')
console.log(`  ${samples.length} distinct commands from ${files} files (${templated} templated commands skipped); engines: ${engines.map(e => `${e.name}=${e.bin}`).join(', ')}`)
check('the corpus is a real census (at least 40 distinct model-written commands)', samples.length >= 40, `${samples.length}`)
const present = new Set(samples.flatMap(s => constructsOf(s.command)))
check('the corpus carries the pipe / and-list / or-list / sequence / redirect / quoting / variable family', ['pipe', 'and-list', 'or-list', 'sequence', 'redirect', 'single-quotes', 'double-quotes', 'variable'].every(name => present.has(name)), [...present].join(', '))
const absent = CONSTRUCTS.map(([name]) => name).filter(name => !present.has(name))
if (absent.length > 0) console.log(`  constructs no fixture command uses (the execution-seam corpus covers them): ${absent.join(', ')}`)
const brush = engines.find(e => e.name === 'brush')
const bash = engines.find(e => e.name === 'bash')
if (!brush) console.log('  [SKIP] no vendored engine binary on this machine (vendor/brush or --brush <path>): the census records the control columns only')

const LONG_SLEEP = /\bsleep\s+([3-9]|[1-9]\d+)\b/
const rows: CensusRow[] = []
section('§2 parse parity (every command) and execution parity (read-only commands)')
for (const sample of samples) {
  const constructs = constructsOf(sample.command)
  let readOnly = false
  try {
    readOnly = checkReadOnlyConstraints({ command: sample.command }, false).behavior === 'allow'
  } catch {
    readOnly = false
  }
  const executable = readOnly && !LONG_SLEEP.test(sample.command)
  const parse: Record<string, number | null> = {}
  const exec: Record<string, RunResult | undefined> = {}
  for (const engine of engines) {
    parse[engine.name] = runEngine(engine, 'parse', sample.command).code
    if (executable) exec[engine.name] = runEngine(engine, 'exec', sample.command)
  }
  const row: CensusRow = { command: sample.command, source: sample.source, constructs, readOnly, executed: executable, parse, exec, verdict: 'control-only', detail: '' }
  if (brush && bash) {
    const problems: string[] = []
    const parseAgree = (parse.bash === 0) === (parse.brush === 0)
    if (!parseAgree) problems.push(`parse bash=${parse.bash} brush=${parse.brush}`)
    if (executable) {
      const a = exec.bash as RunResult
      const b = exec.brush as RunResult
      if (a.code !== b.code) problems.push(`exit bash=${a.code} brush=${b.code}`)
      if (a.stdout.trimEnd() !== b.stdout.trimEnd()) problems.push(`stdout differs: bash ${JSON.stringify(a.stdout.trimEnd().slice(0, 80))} brush ${JSON.stringify(b.stdout.trimEnd().slice(0, 80))}`)
      if ((a.stderr.trim() === '') !== (b.stderr.trim() === '')) problems.push(`stderr presence differs: bash ${JSON.stringify(a.stderr.trim().slice(0, 80))} brush ${JSON.stringify(b.stderr.trim().slice(0, 80))}`)
    }
    const gap = knownGapOf(sample.command)
    row.verdict = problems.length === 0 ? 'same' : gap ? 'known-gap' : 'mismatch'
    row.detail = problems.join('; ') + (gap && problems.length > 0 ? ` [${gap}]` : '')
    const label = `${executable ? 'execution' : 'parse'} parity: ${JSON.stringify(sample.command.length > 70 ? sample.command.slice(0, 67) + '…' : sample.command)}`
    if (row.verdict === 'known-gap') console.log(`  [SKIP] ${label} — known gap: ${row.detail}`)
    else check(label, row.verdict === 'same', row.detail)
  }
  rows.push(row)
}


const esc = (text: string): string => text.replace(/\|/g, '\\|').replace(/\n/g, '⏎')
const lines: string[] = ['# Shell-engine compatibility census', '']
lines.push(`- corpus: ${samples.length} distinct model-written commands from ${files} files under scripts/ (${templated} templated skipped)`)
lines.push(`- engines: ${engines.map(e => `${e.name} = ${e.bin}`).join(' · ')}${brush ? '' : ' (no vendored engine: control columns only)'}`)
lines.push(`- read-only (executed): ${rows.filter(r => r.executed).length} · parse-only: ${rows.filter(r => !r.executed).length}`)
if (brush) lines.push(`- verdicts: same ${rows.filter(r => r.verdict === 'same').length} · mismatch ${rows.filter(r => r.verdict === 'mismatch').length} · known-gap ${rows.filter(r => r.verdict === 'known-gap').length}`)
lines.push('')
const constructCounts = new Map<string, number>()
for (const row of rows) for (const c of row.constructs) constructCounts.set(c, (constructCounts.get(c) ?? 0) + 1)
lines.push('## Constructs used', '', '| construct | commands |', '|---|---|')
for (const [name, count] of [...constructCounts.entries()].sort((a, b) => b[1] - a[1])) lines.push(`| ${name} | ${count} |`)
lines.push('', '## Commands', '')
const header = ['command', 'constructs', 'read-only', ...engines.map(e => `${e.name} -n`), ...engines.map(e => `${e.name} exec`), 'verdict', 'detail']
lines.push(`| ${header.join(' | ')} |`, `|${header.map(() => '---').join('|')}|`)
for (const row of rows) {
  const cells = [
    `\`${esc(row.command)}\``,
    row.constructs.join(', '),
    row.readOnly ? 'yes' : 'no',
    ...engines.map(e => String(row.parse[e.name] ?? 'n/a')),
    ...engines.map(e => (row.exec[e.name] ? `${row.exec[e.name]!.code} (${row.exec[e.name]!.ms}ms)` : '—')),
    row.verdict,
    esc(row.detail),
  ]
  lines.push(`| ${cells.join(' | ')} |`)
}
const reportPath = out ?? join(tmpdir(), 'shell-engine-parity', `census-${Date.now()}.md`)
mkdirSync(resolve(reportPath, '..'), { recursive: true })
writeFileSync(reportPath, lines.join('\n') + '\n')
if (print) console.log(lines.join('\n'))
console.log(`\n  report: ${reportPath}`)

rmSync(SCRATCH, { recursive: true, force: true })

console.log('\n============================================================')
if (failures === 0) console.log(` ✅ THE COMPATIBILITY CENSUS HOLDS (${brush ? 'engine exercised' : 'control only'})`)
else console.log(` ❌ ${failures} CENSUS CHECK(S) FAILED`)
console.log('============================================================')
process.exit(failures === 0 ? 0 : 1)
