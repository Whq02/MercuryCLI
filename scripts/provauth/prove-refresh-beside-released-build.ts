#!/usr/bin/env bun
import '../lib/hermetic.ts'
import { proofHome } from '../lib/hermetic.ts'
import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const RELEASED_SRC_TREE = '73ff6d3d2c0978b79aa0adcccee8d6a658665492'
const repo = resolve(import.meta.dir, '..', '..')
const fixHint = "fix the door in src/models/sign-in/lifecycle/lockedRefresh.ts (the lock file it takes before its own lock, and the pair it keeps when a refused refresh blanked the stored token while its accepted answer was out) or the road's refreshLockFile in src/models/roads/openai/openaiAccounts.ts and src/models/roads/xai/xaiOauth.ts; each process is scripts/provauth/lib/build-refresh-child.ts"
let failures = 0
let passes = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (ok) passes++
  else failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${ok ? '' : `${detail ? ` — ${detail}` : ''} — ${fixHint}`}`)
}
const sleep = (ms: number): Promise<void> => new Promise(done => setTimeout(done, ms))
const within = (work: Promise<unknown>, ms: number): Promise<boolean> => Promise.race([work.then(() => true), sleep(ms).then(() => false)])
async function reached(what: string, work: Promise<unknown>): Promise<void> {
  if (!(await within(work, 60_000))) throw new Error(`timed out waiting until ${what} — ${fixHint}`)
}

type Road = 'openai' | 'xai'
type Build = 'released' | 'tree'
const roots: Record<Build, string> = { released: join(proofHome, 'released'), tree: repo }
const stores: Record<Road, string> = { openai: '.openai-auth.json', xai: '.xai-auth.json' }
const EMAIL = 'row@example.invalid'
const jwt = (payload: Record<string, unknown>): string => `h.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.s`

function unpackReleasedSource(): void {
  mkdirSync(roots.released)
  const tar = join(proofHome, 'released.tar')
  const archived = spawnSync('git', ['-C', repo, 'archive', '--format=tar', '--prefix=src/', '-o', tar, RELEASED_SRC_TREE], { encoding: 'utf8' })
  if (archived.status !== 0) throw new Error(`git archive of the released source ended ${archived.status}: ${archived.stderr.trim()}`)
  const unpacked = spawnSync('tar', ['-xf', tar, '-C', roots.released], { encoding: 'utf8' })
  if (unpacked.status !== 0) throw new Error(`tar of the released source ended ${unpacked.status}: ${unpacked.stderr.trim()}`)
  writeFileSync(join(roots.released, 'tsconfig.json'), JSON.stringify({ compilerOptions: { baseUrl: '.' } }))
  symlinkSync(join(repo, 'node_modules'), join(roots.released, 'node_modules'), 'junction')
}

let homes = 0
function signedInHome(road: Road): { home: string; store: string } {
  const home = join(proofHome, `home-${++homes}`)
  mkdirSync(home)
  const store = join(home, stores[road])
  const endsAt = Date.now() + 60_000
  const accessToken = jwt({ exp: Math.floor(endsAt / 1000) })
  const tokens = road === 'openai' ? { idToken: 'h.e30.s', accessToken, refreshToken: 'rt-0', email: EMAIL, planType: 'plus', accessTokenExpiresAtMs: endsAt } : { accessToken, refreshToken: 'rt-0', expiresAtMs: endsAt, email: EMAIL }
  writeFileSync(store, JSON.stringify({ version: 1, preferredSource: road === 'openai' ? 'chatgpt-subscription' : 'grok-subscription', tokens }, null, 2) + '\n', { mode: 0o600 })
  return { home, store }
}
const storedRefresh = (store: string): string | undefined => (JSON.parse(readFileSync(store, 'utf8')) as { tokens?: { refreshToken?: string } }).tokens?.refreshToken

interface Gate {
  open: () => void
  opened: Promise<void>
}
function gate(): Gate {
  let open: () => void = () => {}
  const opened = new Promise<void>(done => { open = done })
  return { open, opened }
}

interface Provider {
  base: string
  presented: string[]
  live: () => string
  arrived: (n: number) => Promise<void>
  answer: (n: number) => void
  answerAll: () => void
  stop: () => void
}
function provider(): Provider {
  const presented: string[] = []
  const arrivals: Gate[] = []
  const answers: Gate[] = []
  const at = (gates: Gate[], n: number): Gate => (gates[n] ??= gate())
  let live = 'rt-0'
  let held = true
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request: Request): Promise<Response> {
      const offered = new URLSearchParams(await request.text()).get('refresh_token') ?? ''
      const n = presented.push(offered)
      const minted = offered === live ? `rt-${n}` : undefined
      if (minted) live = minted
      at(arrivals, n).open()
      if (held) await at(answers, n).opened
      if (!minted) return Response.json({ error: 'invalid_grant', error_description: 'refresh token already used' }, { status: 400 })
      return Response.json({
        token_type: 'Bearer',
        access_token: jwt({ exp: Math.floor(Date.now() / 1000) + 3600, n }),
        id_token: jwt({ email: EMAIL, 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-stand-in', chatgpt_plan_type: 'plus' } }),
        refresh_token: minted,
        expires_in: 3600,
      })
    },
  })
  return {
    base: `http://127.0.0.1:${server.port}`,
    presented,
    live: () => live,
    arrived: n => at(arrivals, n).opened,
    answer: n => at(answers, n).open(),
    answerAll: () => {
      held = false
      for (const each of answers) each?.open()
    },
    stop: () => void server.stop(true),
  }
}

type Ended = { answer?: string | null; threw?: string }
interface Process {
  ready: Promise<void>
  about: Promise<number>
  ended: Promise<Ended>
  go: () => void
  kill: () => void
}
function start(build: Build, road: Road, home: string, base: string, clockAheadMs = 0): Process {
  const proc = spawn(process.execPath, ['run', join(import.meta.dir, 'lib', 'build-refresh-child.ts'), roots[build], road, String(clockAheadMs)], {
    env: { ...process.env, MERCURY_CONFIG_DIR: home, MERCURY_LOCAL_PROBE_TARGETS: 'none', MERCURY_OPENAI_AUTH_BASE: base, MERCURY_XAI_AUTH_BASE: base },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let out = ''
  let err = ''
  const ready = gate()
  let tell: (pid: number) => void = () => {}
  const about = new Promise<number>(done => { tell = done })
  proc.stdout.on('data', chunk => {
    out += String(chunk)
    if (out.includes('"ready":true')) ready.open()
    const said = /"about":"refresh","pid":(\d+)/.exec(out)
    if (said) tell(Number(said[1]))
  })
  proc.stderr.on('data', chunk => { err += String(chunk) })
  const overdue = setTimeout(() => proc.kill('SIGKILL'), 120_000)
  const ended = new Promise<Ended>(done => {
    proc.on('close', code => {
      clearTimeout(overdue)
      const last = out.trim().split('\n').at(-1) ?? ''
      done(last.includes('"answer"') || last.includes('"threw"') ? (JSON.parse(last) as Ended) : { threw: `the process ended rc=${code} with no answer: ${err.slice(-300)}` })
    })
  })
  return { ready: ready.opened, about, ended, go: () => void proc.stdin.write('go\n'), kill: () => void proc.kill('SIGKILL') }
}

interface Outcome {
  presented: string[]
  live: string
  stored: string | undefined
  secondAskedAfterMs: number | undefined
  ends: [Ended, Ended]
  lockLeft: boolean
  firstPid: number
  stampWhileHeld: string | undefined
}
function aged(file: string, ms: number): void {
  const then = new Date(Date.now() - ms)
  utimesSync(file, then, then)
}
async function twoProcesses(road: Road, first: Build, second: Build, heldMs: number, standing?: string): Promise<Outcome> {
  const { home, store } = signedInHome(road)
  const lockFile = `${store}.refresh-lock`
  if (standing !== undefined) {
    writeFileSync(lockFile, standing, { mode: 0o600 })
    aged(lockFile, 31_000)
  }
  const stand = provider()
  try {
    const a = start(first, road, home, stand.base)
    const b = start(second, road, home, stand.base)
    await reached('both processes have loaded their build', Promise.all([a.ready, b.ready]))
    a.go()
    await reached('the first process has its refresh at the provider, or has ended without one', Promise.race([stand.arrived(1), a.ended]))
    const stampWhileHeld = existsSync(lockFile) ? readFileSync(lockFile, 'utf8') : undefined
    b.go()
    await reached('the second process has asked its build for the sign-in', b.about)
    const asked = Date.now()
    const secondAsked = await within(stand.arrived(2), heldMs)
    const secondAskedAfterMs = secondAsked ? Date.now() - asked : undefined
    if (secondAsked) {
      stand.answer(2)
      await reached('the second process has ended', b.ended)
    }
    stand.answerAll()
    const ends = await Promise.all([a.ended, b.ended])
    return { presented: stand.presented, live: stand.live(), stored: storedRefresh(store), secondAskedAfterMs, ends, lockLeft: existsSync(`${store}.lock`) || existsSync(lockFile), firstPid: await a.about, stampWhileHeld }
  } finally {
    stand.stop()
  }
}

interface Inherited {
  pid: number
  stamp: string | undefined
  heir: Ended
  presented: string[]
  stored: string | undefined
  lockFileLeft: boolean
}
async function killedWhileItHeld(road: Road): Promise<Inherited> {
  const { home, store } = signedInHome(road)
  const silent = provider()
  const stand = provider()
  stand.answerAll()
  try {
    const holder = start('tree', road, home, silent.base)
    await reached("this tree's process has loaded", holder.ready)
    holder.go()
    await reached('its refresh is at a provider that never answers', Promise.all([holder.about, silent.arrived(1)]))
    const lockFile = `${store}.refresh-lock`
    const stamp = existsSync(lockFile) ? readFileSync(lockFile, 'utf8') : undefined
    holder.kill()
    await holder.ended
    const heir = start('released', road, home, stand.base, road === 'openai' ? 31_000 : 0)
    await reached('the released build has loaded', heir.ready)
    heir.go()
    return { pid: await holder.about, stamp, heir: await heir.ended, presented: stand.presented, stored: storedRefresh(store), lockFileLeft: existsSync(lockFile) }
  } finally {
    silent.stop()
    stand.stop()
  }
}

interface Outwaited {
  waitedMs: number
  end: Ended
  presented: string[]
  stored: string | undefined
  stampStands: boolean
}
async function lockHeldPastThePatience(road: Road): Promise<Outwaited> {
  const { home, store } = signedInHome(road)
  const stand = provider()
  stand.answerAll()
  try {
    const waiter = start('tree', road, home, stand.base)
    await reached("this tree's process has loaded", waiter.ready)
    const stamp = road === 'openai' ? `${process.pid} ${Date.now()}\n` : `${process.pid} ${randomUUID()}`
    writeFileSync(`${store}.refresh-lock`, stamp, { mode: 0o600 })
    aged(`${store}.refresh-lock`, 5_000)
    const asked = Date.now()
    waiter.go()
    const end = await waiter.ended
    return { waitedMs: Date.now() - asked, end, presented: stand.presented, stored: storedRefresh(store), stampStands: readFileSync(`${store}.refresh-lock`, 'utf8') === stamp }
  } finally {
    stand.stop()
  }
}

const beside = spawnSync('git', ['-C', repo, 'cat-file', '-e', `${RELEASED_SRC_TREE}^{tree}`]).status === 0
if (beside) unpackReleasedSource()
else console.log(`the scenes that run 1.1.0 beside this tree are not staged: this clone does not hold the released source (the src tree of tag v1.1.0, ${RELEASED_SRC_TREE.slice(0, 10)}); a clone with its history does`)

const scenes: Array<{ name: string; road: Road; first: Build; second: Build; standing?: string }> = [
  { name: 'ChatGPT, this tree first and 1.1.0 second', road: 'openai', first: 'tree', second: 'released' },
  { name: 'Grok, this tree first and 1.1.0 second', road: 'xai', first: 'tree', second: 'released' },
  { name: 'ChatGPT, two processes of this tree', road: 'openai', first: 'tree', second: 'tree' },
  { name: 'ChatGPT, 1.1.0 first and this tree second', road: 'openai', first: 'released', second: 'tree' },
  { name: 'Grok, 1.1.0 first and this tree second', road: 'xai', first: 'released', second: 'tree' },
  { name: 'Grok, two processes of this tree', road: 'xai', first: 'tree', second: 'tree' },
  { name: 'Grok behind a stamp thirty-one seconds old whose pid is another live process, this tree first and 1.1.0 second', road: 'xai', first: 'tree', second: 'released', standing: `${process.pid} ${randomUUID()}` },
]
const quick = scenes.filter(each => beside || (each.first === 'tree' && each.second === 'tree'))
const slowProvider = beside ? twoProcesses('openai', 'tree', 'released', 11_000) : undefined
const outwaited = Promise.all([lockHeldPastThePatience('openai'), lockHeldPastThePatience('xai')])
const outcomes: Outcome[] = []
for (let at = 0; at < quick.length; at += 3) outcomes.push(...(await Promise.all(quick.slice(at, at + 3).map(each => twoProcesses(each.road, each.first, each.second, 3_000, each.standing)))))

console.log('── one sign-in, two processes, the first refresh still out: the second asks the provider nothing, whichever build it is ──')
quick.forEach((each, i) => {
  const o = outcomes[i]
  if (!o) return
  check(`${each.name}: one refresh reached the provider`, o.secondAskedAfterMs === undefined && o.presented.length === 1, JSON.stringify({ presented: o.presented, secondAskedAfterMs: o.secondAskedAfterMs }))
  check(`${each.name}: the home is signed in with the provider's live pair and both processes hold it`, o.live === 'rt-1' && o.stored === 'rt-1' && o.ends.every(end => end.answer === 'rt-1'), JSON.stringify({ live: o.live, stored: o.stored ?? null, ends: o.ends }))
  check(`${each.name}: no lock is left beside the store`, !o.lockLeft)
  if (each.standing !== undefined) check(`${each.name}: while it holds, the lock file carries its own stamp and not the old one`, o.stampWhileHeld !== undefined && new RegExp(`^${o.firstPid} \\d{13}\\n$`).test(o.stampWhileHeld), JSON.stringify({ pid: o.firstPid, stamp: o.stampWhileHeld ?? null }))
})

console.log('── a process killed while it held the lock leaves a stamp 1.1.0 clears by its own rule ──')
for (const [road, name, rule] of beside ? ([['openai', 'ChatGPT', 'thirty-one seconds on by its clock, the stamp is stale by age'], ['xai', 'Grok', 'the pid in the stamp is gone']] as const) : []) {
  const left = await killedWhileItHeld(road)
  check(`${name}: the stamp it leaves is its pid and then the time, the form both of 1.1.0's readers take`, left.stamp !== undefined && new RegExp(`^${left.pid} \\d{13}\\n$`).test(left.stamp), JSON.stringify({ pid: left.pid, stamp: left.stamp ?? null }))
  check(`${name}: the released build (${rule}) takes the lock, refreshes once and leaves no lock file`, left.heir.answer === 'rt-1' && left.presented.length === 1 && left.stored === 'rt-1' && !left.lockFileLeft, JSON.stringify({ heir: left.heir, presented: left.presented, stored: left.stored ?? null, lockFileLeft: left.lockFileLeft }))
}

console.log('── a provider slower than 1.1.0 waits: its ChatGPT door asks without the lock after eight seconds, and the accepted pair is still kept ──')
const slow = await slowProvider
if (slow) {
  check('1.1.0 waited its eight seconds on the lock this tree holds, then asked without it and was refused', slow.secondAskedAfterMs !== undefined && slow.secondAskedAfterMs >= 7_000 && slow.presented.length === 2 && slow.ends[1].answer === null, JSON.stringify({ secondAskedAfterMs: slow.secondAskedAfterMs, presented: slow.presented, second: slow.ends[1] }))
  check("the accepted answer, arriving after that refusal blanked the stored token, is kept: the home is signed in with the provider's live pair", slow.live === 'rt-1' && slow.stored === 'rt-1' && slow.ends[0].answer === 'rt-1', JSON.stringify({ live: slow.live, stored: slow.stored ?? null, first: slow.ends[0] }))
  check('no lock is left beside the store', !slow.lockLeft)
}

console.log("── a 1.1.0 lock that a live process holds for longer than this tree waits: the provider is asked nothing and the lock file is not touched ──")
const [chatgptWaited, grokWaited] = await outwaited
check('ChatGPT: after its wait the call answers the pair that stands, having asked nothing', chatgptWaited.waitedMs > 15_000 && chatgptWaited.end.answer === 'rt-0' && chatgptWaited.presented.length === 0 && chatgptWaited.stored === 'rt-0' && chatgptWaited.stampStands, JSON.stringify(chatgptWaited))
check("Grok, the stamp five seconds old when the call began: after its wait the call refuses in 1.1.0's own words, having asked nothing", grokWaited.waitedMs > 15_000 && grokWaited.end.threw === 'Another process is refreshing Grok; retry after it finishes.' && grokWaited.presented.length === 0 && grokWaited.stored === 'rt-0' && grokWaited.stampStands, JSON.stringify(grokWaited))

console.log(failures === 0 ? `\nREFRESH BESIDE THE RELEASED BUILD GREEN (${passes} checks; real processes of ${beside ? 'the released 1.1.0 source and of this tree' : 'this tree alone, the released source not being in this clone'}, loopback token servers, no live host)` : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
