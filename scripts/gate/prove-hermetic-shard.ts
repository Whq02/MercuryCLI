#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
process.chdir(ROOT)
const { FLAG_REGISTRY } = await import('../../src/substrate/flagRegistry.ts')
const { FIXTURE_API_KEY, seedFirstRun } = await import('../lib/firstRunSeed.ts')

const DIST = join(ROOT, 'dist', 'mercury.mjs')
const BOX_HOST = '127.0.0.1'
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost', '0.0.0.0', '::'])
const FAMILY_BASE = /^MERCURY_[A-Z0-9]+_(?:[A-Z]+_)*BASE$/
const NOT_A_FAMILY = new Set(['MERCURY_DESCRIPTOR_STOCK_BASE'])
const UPDATE_SEAM = 'MERCURY_UPDATE_API_BASE_URL'
const SLOTS = ['MERCURY_COMPAT_BASE_URL', 'MERCURY_LOCAL_BASE_URL', 'MERCURY_CUSTOM_OAUTH_URL']
const INHERITED_GATEWAY = 'https://gateway.example.invalid'
const DEADLINE_BOUND_MS = 15_000
const INVALID_KEY = /Invalid API key/

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log(`\n${'─'.repeat(76)}\n${t}`)
}

console.log('============================================================')
console.log(' hermetic shard — no request leaves the box')
console.log('============================================================')

if (!existsSync(DIST)) {
  console.log('❌ dist/mercury.mjs absent — build first (the pooled gate prebuilds it)')
  process.exit(1)
}
const nodeBin = Bun.which('node')
if (!nodeBin) {
  console.log('❌ no node binary on PATH')
  process.exit(1)
}

const work = mkdtempSync(join(tmpdir(), 'hermetic-shard-'))
const cleanup = (): void => rmSync(work, { recursive: true, force: true })
const guard = setTimeout(() => {
  console.log('\n❌ TIMEOUT — the hermetic shard proof exceeded 240 s')
  cleanup()
  process.exit(1)
}, 240_000)

const ambientKey = process.env.ANTHROPIC_API_KEY || FIXTURE_API_KEY

const preload = join(work, 'net-census.cjs')
writeFileSync(
  preload,
  `'use strict'
const fs = require('node:fs')
const net = require('node:net')
const dns = require('node:dns')
const LOG = process.env.PROOF_NETLOG
const log = line => { try { fs.appendFileSync(LOG, process.pid + ' ' + line + '\\n') } catch {} }
const origConnect = net.Socket.prototype.connect
net.Socket.prototype.connect = function (...args) {
  const head = Array.isArray(args[0]) ? args[0][0] : args[0]
  const opts = typeof head === 'object' && head !== null ? head : { port: args[0], host: args[1] }
  if (opts.path) log('unix ' + opts.path)
  else if (opts.port === undefined && opts.host === undefined) log('local ' + Object.keys(opts).join(','))
  else log('tcp ' + (opts.host || 'localhost') + ':' + opts.port)
  return origConnect.apply(this, args)
}
const origLookup = dns.lookup
dns.lookup = function (hostname, ...rest) { log('dns ' + hostname); return origLookup.call(this, hostname, ...rest) }
const origFetch = globalThis.fetch
if (typeof origFetch === 'function') {
  globalThis.fetch = function (input, init) {
    log('fetch ' + (typeof input === 'string' ? input : (input && input.url) || String(input)))
    return origFetch.call(this, input, init)
  }
}
try { require('node:module').syncBuiltinESMExports() } catch {}
`,
)

const probeScript = join(work, 'probe.cjs')
writeFileSync(
  probeScript,
  `'use strict'
const http = require('node:http')
const fs = require('node:fs')
const base = new URL(process.env.ANTHROPIC_BASE_URL)
const hit = (method, path, body) => new Promise(resolve => {
  const t0 = Date.now()
  const req = http.request({ host: base.hostname, port: base.port, method, path, headers: body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {} }, res => {
    let data = ''
    res.on('data', c => { data += c })
    res.on('end', () => resolve({ status: res.statusCode, retry: res.headers['x-should-retry'] ?? null, body: data, ms: Date.now() - t0 }))
  })
  req.on('error', e => resolve({ status: 0, retry: null, body: String(e.code || e.message), ms: Date.now() - t0 }))
  if (body) req.write(body)
  req.end()
})
;(async () => {
  const messages = await hit('POST', '/v1/messages', JSON.stringify({ model: 'probe', max_tokens: 1, messages: [{ role: 'user', content: 'x'.repeat(200000) }] }))
  const root = await hit('GET', '/')
  fs.writeFileSync(process.argv[2], JSON.stringify({ messages, root }))
})()
`,
)

function turnScript(opts: { cwd: string; netlog: string; out: string; err: string; rc: string; ms: string }): string {
  return [
    `cd '${opts.cwd}' || exit 9`,
    `rm -f '${opts.netlog}'`,
    `t0=$(perl -MTime::HiRes=time -e 'printf "%d", time*1000')`,
    `NODE_OPTIONS='--require ${preload}' PROOF_NETLOG='${opts.netlog}' perl -e 'alarm 90; exec @ARGV' -- '${nodeBin}' '${DIST}' -p 'say hi' --output-format json >'${opts.out}' 2>'${opts.err}'`,
    `echo $? >'${opts.rc}'`,
    `t1=$(perl -MTime::HiRes=time -e 'printf "%d", time*1000')`,
    `echo $(( t1 - t0 )) >'${opts.ms}'`,
  ].join('\n')
}
const readTrim = (p: string): string => (existsSync(p) ? readFileSync(p, 'utf8').trim() : '')
const censusOf = (p: string): string[] => readTrim(p).split('\n').filter(Boolean)
function outsideOf(lines: string[]): string[] {
  return lines.filter(l => {
    const m = /^\d+ (tcp|dns|fetch) (.+)$/.exec(l)
    if (!m) return false
    const target = m[2]!
    if (m[1] === 'tcp') return !LOOPBACK.has(target.slice(0, target.lastIndexOf(':')))
    if (m[1] === 'dns') return !LOOPBACK.has(target)
    try {
      return !LOOPBACK.has(new URL(target).hostname.replace(/^\[|\]$/g, ''))
    } catch {
      return true
    }
  })
}
const portOf = (base: string): number => {
  try {
    return Number(new URL(base).port)
  } catch {
    return 0
  }
}

const home = join(work, 'config-home')
const cwd = join(work, 'cwd')
mkdirSync(cwd, { recursive: true })
seedFirstRun(home, [ROOT, cwd])
const baseEnv: NodeJS.ProcessEnv = {
  ...process.env,
  MERCURY_CONFIG_DIR: home,
  MERCURY_HOME: join(work, 'boot-home'),
  MERCURY_CREDENTIAL_STORE: 'file',
  BROWSER: '/usr/bin/true',
  ANTHROPIC_API_KEY: ambientKey,
}
for (const k of ['NODE_OPTIONS', 'MERCURY_SUITE_TIMEOUT', 'MERCURY_SUITE_TIMEOUT_FLOOR', 'MERCURY_SUITE_CEILING']) delete baseEnv[k]
for (const k of Object.keys(baseEnv)) if (FAMILY_BASE.test(k) || k === 'ANTHROPIC_BASE_URL' || k === UPDATE_SEAM) delete baseEnv[k]

section('§1/§2/§3 — the runner\'s pin, read and probed by a suite; one headless turn under it')
const suites = join(work, 'suites')
const out = join(work, 'out')
const pinned = {
  env: join(work, 'env.txt'),
  probe: join(work, 'probe.json'),
  netlog: join(work, 'net-pinned.log'),
  out: join(work, 'turn-pinned.json'),
  err: join(work, 'turn-pinned.err'),
  rc: join(work, 'turn-pinned.rc'),
  ms: join(work, 'turn-pinned.ms'),
}
mkdirSync(join(suites, 'hermetic'), { recursive: true })
writeFileSync(
  join(suites, 'hermetic', 'run-all.sh'),
  `#!/usr/bin/env bash\n# gate-class: pure\nenv >'${pinned.env}'\n'${nodeBin}' '${probeScript}' '${pinned.probe}'\n${turnScript({ cwd, ...pinned })}\nexit 0\n`,
)
chmodSync(join(suites, 'hermetic', 'run-all.sh'), 0o755)
writeFileSync(join(work, 'seed.tsv'), 'hermetic\t30\n')
writeFileSync(join(work, 'ceilings.tsv'), '')
const shard = spawnSync('bash', ['scripts/gate/ci-shard.sh', '0', '1'], {
  cwd: ROOT,
  env: {
    ...baseEnv,
    MERCURY_CI_SHARD_SUITES_DIR: suites,
    MERCURY_CI_SHARD_SEED_FILE: join(work, 'seed.tsv'),
    MERCURY_CI_SHARD_CEILING_FILE: join(work, 'ceilings.tsv'),
    MERCURY_CI_SHARD_OUT: out,
    ANTHROPIC_BASE_URL: INHERITED_GATEWAY,
  },
  encoding: 'utf8',
  timeout: 200_000,
  killSignal: 'SIGKILL',
})
check('the synthetic shard ran to a verdict (rc 0: the suite reports, never fails)', shard.status === 0, (shard.stdout + shard.stderr).slice(-400))

const dump: Record<string, string> = {}
for (const line of readTrim(pinned.env).split('\n')) {
  const i = line.indexOf('=')
  if (i > 0) dump[line.slice(0, i)] = line.slice(i + 1)
}
const box = dump.ANTHROPIC_BASE_URL ?? ''
const boxPort = portOf(box)
check('the runner exports ONE loopback address, http://127.0.0.1:<port>', /^http:\/\/127\.0\.0\.1:\d+$/.test(box), box || '(unset)')
check('an inherited gateway base is overridden, never honoured', box !== INHERITED_GATEWAY)
const families = FLAG_REGISTRY.map(r => r.env).filter(e => FAMILY_BASE.test(e) && !NOT_A_FAMILY.has(e))
const unpinned = families.filter(k => dump[k] !== box)
check(
  `every provider-family base the registry lists rides the box (${families.length} registry rows + the SDK's own)`,
  families.length >= 10 && unpinned.length === 0,
  unpinned.length > 0 ? `unpinned: ${unpinned.join(' ')}` : `only ${families.length} family rows found`,
)
check(`the update channel's anonymous road rides the box (${UPDATE_SEAM})`, dump[UPDATE_SEAM] === box, `dump=${dump[UPDATE_SEAM] ?? '(unset)'}`)
for (const k of SLOTS) check(`${k} is left as the runner found it (a base there configures a slot, or throws)`, dump[k] === baseEnv[k], `dump=${dump[k] ?? '(unset)'} env=${baseEnv[k] ?? '(unset)'}`)

section('§2 — the box answers like the real host, in milliseconds')
let probe: { messages: { status: number; retry: string | null; body: string; ms: number }; root: { status: number; ms: number } } | null = null
try {
  probe = JSON.parse(readTrim(pinned.probe))
} catch {
  probe = null
}
check('the probe reached the box from inside the suite', probe !== null, readTrim(pinned.probe).slice(0, 200) || '(no probe record)')
if (probe) {
  check(`a messages request is answered 401 with the vendor error body — ${probe.messages.ms} ms`, probe.messages.status === 401 && /authentication_error/.test(probe.messages.body) && probe.messages.ms < 2_000, `${probe.messages.status} ${probe.messages.body.slice(0, 120)}`)
  check('the answer carries x-should-retry: false (the header the retry ladder obeys)', probe.messages.retry === 'false', String(probe.messages.retry))
  check(`the reachability probe on / is answered 200 — ${probe.root.ms} ms`, probe.root.status === 200 && probe.root.ms < 2_000, String(probe.root.status))
}

section('§3 — under the pin: zero egress, the box named, the host\'s answer in milliseconds')
const lines = censusOf(pinned.netlog)
const outside = outsideOf(lines)
check(`zero connections, lookups or fetches outside the loopback (${lines.length} census lines)`, lines.length > 0 && outside.length === 0, outside.slice(0, 5).join(' · ') || '(empty census)')
check('the turn went to the box (the census names its port)', boxPort > 0 && lines.some(l => l.endsWith(`tcp ${BOX_HOST}:${boxPort}`)), lines.slice(0, 6).join(' · '))
const pinnedText = readTrim(pinned.out) + readTrim(pinned.err)
check('the turn reports the invalid key — the real host\'s answer, now from the box', readTrim(pinned.rc) !== '' && readTrim(pinned.rc) !== '0' && INVALID_KEY.test(pinnedText), pinnedText.slice(0, 300) || '(no report)')
const ms = Number(readTrim(pinned.ms))
check(`the turn ends inside the deadline bound — ${ms} ms (bound ${DEADLINE_BOUND_MS})`, ms > 0 && ms < DEADLINE_BOUND_MS)
console.log(`  · the pinned turn's report: ${pinnedText.replace(/\s+/g, ' ').slice(0, 220)}`)

clearTimeout(guard)
cleanup()
console.log(`\n${failures === 0 ? '✅' : '❌'} prove-hermetic-shard — ${failures === 0 ? 'all checks pass' : `${failures} check(s) failed`}`)
process.exit(failures === 0 ? 0 : 1)
