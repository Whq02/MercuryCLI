#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const at = process.argv.indexOf('--dist')
const dist = resolve(at >= 0 ? process.argv[at + 1]! : join(import.meta.dir, '../../dist/mercury.mjs'))
if (!existsSync(dist)) {
  console.log(`FAIL ${dist} missing — run bun run build.ts first`)
  process.exit(1)
}
const home = mkdtempSync(join(tmpdir(), 'help-words-'))
writeFileSync(join(home, '.config.json'), JSON.stringify({ hasCompletedOnboarding: true, theme: 'dark' }))
const env = { HOME: home, PATH: process.env.PATH, TERM: 'xterm-256color', COLUMNS: '200', MERCURY_CONFIG_DIR: home, MERCURY_CREDENTIAL_STORE: 'file', MERCURY_LOCAL_PROBE_TARGETS: 'none', MERCURY_DAEMON_DIR: join(home, 'daemon'), TMPDIR: tmpdir(), NO_COLOR: '1' }
let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${!ok && detail ? `: ${detail}` : ''}`)
  if (!ok) failures++
}
function mercury(args: string[]): { code: number | null; text: string } {
  const r = spawnSync('node', [dist, ...args], { cwd: home, env, encoding: 'utf8', timeout: 120_000 })
  return { code: r.status, text: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}
function commandsOf(text: string): string[] {
  const lines = text.split(/\r?\n/)
  const start = lines.findIndex(l => /^Commands:/.test(l))
  if (start < 0) return []
  const names: string[] = []
  for (const line of lines.slice(start + 1)) {
    const m = /^  ([a-z][a-z0-9-]*)(\|[a-z-]+)?(\s|$)/.exec(line)
    if (m && m[1] !== 'help') names.push(m[1]!)
  }
  return names
}
const pages = new Map<string, string>()
const exits = new Map<string, number | null>()
function walk(path: string[]): void {
  const { code, text } = mercury([...path, '--help'])
  const key = path.length === 0 ? 'mercury' : path.join(' ')
  pages.set(key, text)
  exits.set(key, code)
  if (path[0] === 'daemon') return
  for (const name of commandsOf(text)) walk([...path, name])
}
walk([])
function prose(text: string): string {
  return text
    .split(/\r?\n/)
    .filter(l => !/^Usage:/.test(l))
    .map(l => (/^  \S/.test(l) ? l.replace(/^  \S[^\n]*?\s{2,}/, '') : l))
    .join(' ')
    .replace(/\s+/g, ' ')
}
function glossAround(body: string, index: number): string | null {
  const open = body.lastIndexOf('(', index)
  if (open < 0 || body.slice(open, index).includes(')')) return null
  const close = body.indexOf(')', index)
  if (close < 0 || body.slice(index, close).includes('(')) return null
  const inside = body.slice(open + 1, close)
  return inside.length <= 40 && inside.split(' ').length <= 5 ? inside : null
}
type Term = { name: string; bare: RegExp; pages?: RegExp }
const TERMS: Term[] = [
  { name: 'concourse', bare: /\bconcourse\b/gi },
  { name: 'Boot face', bare: /\bboot face\b/gi },
  { name: 'strip', bare: /\bstrip\b/g },
  { name: 'at birth', bare: /\bat birth\b/g },
  { name: 'advisor', bare: /\badvisor\b/g },
  { name: 'system brief', bare: /\bsystem brief\b/g },
  { name: 'config home', bare: /\bconfig home\b/g },
  { name: 'sovereign', bare: /\bsovereign\b/g },
  { name: 'label', bare: /(?<![@<[])\blabel\b(?![>\]])/g },
  { name: 'card', bare: /\bcard\b/g },
  { name: 'fence', bare: /(?<!un)\bfence\b/g },
  { name: 'catalogue', bare: /\bcatalogue\b/g },
  { name: 'switch', bare: /\bswitch\b/g, pages: /^extensions/ },
  { name: 'certificate', bare: /\bcertificate\b/g },
  { name: 'cells', bare: /\bcells\b/gi },
  { name: 'frozen project', bare: /\bfrozen projects?\b/g },
  { name: 'daemon', bare: /\bdaemon\b/g },
  { name: 'worker', bare: /\bworkers?\b/g },
  { name: 'deployed build', bare: /\bdeployed build\b/g },
]
const INSIDER: RegExp[] = [/plain world/i, /classic feel/, /\breaped\b/, /Cells-tier/, /\bsupervisor\b/i, /\broads\b/, /display help for command/, /(?<!Boot |boot )\bface\b/]

console.log('§0 the walk')
check('every page exits 0', [...exits.values()].every(code => code === 0), [...exits].filter(([, code]) => code !== 0).map(([key, code]) => `${key}=${code}`).join(', '))
check('the walk reached the root, every verb and every sub-command (41 pages)', pages.size === 41, `${pages.size}: ${[...pages.keys()].join(', ')}`)

console.log("§1 a name's first use on a page carries its plain words, once; later uses stand alone")
let taught = 0
for (const [key, text] of pages) {
  const body = prose(text)
  for (const term of TERMS) {
    if (term.pages !== undefined && !term.pages.test(key)) continue
    const uses = [...body.matchAll(term.bare)]
    if (uses.length === 0) continue
    const glossed = uses.filter(use => glossAround(body, use.index!) !== null)
    const first = uses[0]!
    const context = body.slice(Math.max(0, first.index! - 60), first.index! + 50)
    check(`${key}: the first "${term.name}" is taught in brackets beside its plain words`, glossAround(body, first.index!) !== null, `…${context}…`)
    check(`${key}: "${term.name}" is taught once, then named alone (${uses.length} use${uses.length === 1 ? '' : 's'})`, glossed.length === 1, `${glossed.length} bracketed uses`)
    taught++
  }
}
check('the census found names to teach (the table is not vacuous)', taught >= 20, String(taught))

console.log('§2 no page speaks an insider phrase')
for (const [key, text] of pages) {
  const body = prose(text)
  for (const re of INSIDER) {
    const hit = re.exec(body)
    check(`${key}: no ${re.source}`, hit === null, hit ? `…${body.slice(Math.max(0, hit.index - 40), hit.index + 40)}…` : '')
  }
}

console.log('§3 the sentences a newcomer stumbled on say what they mean')
for (const key of ['mercury', 'run', 'runner']) {
  const body = prose(pages.get(key) ?? '')
  const modeAt = body.indexOf('Permission mode')
  check(`${key}: --mode glosses each of the six modes`, ['default', 'implement', 'dontAsk', 'sovereign', 'flow', 'apollo'].every(mode => new RegExp(`${mode}: [a-z]`).test(body)), body.slice(Math.max(0, modeAt), modeAt + 160))
  check(`${key}: --budget names its unit`, /--budget <usd>/.test(pages.get(key) ?? '') && /in US dollars/.test(body))
  check(`${key}: --allowed-tools shows the rule shape`, /Bash\(git \*\)/.test(body) && /mcp__server__tool/.test(body))
  check(`${key}: --block-tools points at the same shape`, /same shape as --allowed-tools/.test(body))
  check(`${key}: --config-layers names its sources`, /user, project, local/.test(body))
  check(`${key}: --project says it comes first`, /mercury --project <dir> run/.test(body))
}
check('roster: --config-layers names its sources', /user, project, local/.test(prose(pages.get('roster') ?? '')))
check('run: the prompt argument says what stdin does', /no prompt reads it from stdin to the end/.test(prose(pages.get('run') ?? '')))
check('install is true on a build tree', /a build tree is refused/.test(prose(pages.get('install') ?? '')))
check('image: --protocol names the four protocols', /iterm, kitty, sixel or cells/.test(prose(pages.get('image') ?? '')))
for (const key of ['auth', 'mcp', 'extensions']) {
  check(`${key}: the help row says Show help for a command`, /help \[command\]\s+Show help for a command/.test(pages.get(key) ?? ''))
}

console.log('§4 the daemon page has the shape of every other page')
const daemon = pages.get('daemon') ?? ''
check('Usage: mercury daemon …', /^Usage: mercury daemon/.test(daemon), daemon.split('\n')[0] ?? '')
check('an Options block with -h, --help  Show help', /Options:\n  -h, --help\s+Show help/.test(daemon))
check('a Commands block naming run, status, stop and restart', /Commands:\n\s+run \[dir\]/.test(daemon) && /\n\s+status\s/.test(daemon) && /\n\s+stop\s/.test(daemon) && /\n\s+restart\s/.test(daemon))
for (const spelling of ['help', '-h']) {
  const r = mercury(['daemon', spelling])
  check(`mercury daemon ${spelling} prints the same page`, r.code === 0 && r.text === daemon, `exit ${r.code}: ${r.text.split('\n')[0] ?? ''}`)
}

rmSync(home, { recursive: true, force: true })
console.log(`help words: ${failures === 0 ? 'all green' : `${failures} failure(s)`}`)
process.exit(failures === 0 ? 0 : 1)
