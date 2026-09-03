#!/usr/bin/env bun
// ============================================================================
//  scripts/switchboard/prove-folder-project-drive.ts — THE FOLDER IS THE
//  PROJECT on the REAL built bundle through the PTY capture substrate
//  (vshot.py) in seeded scratch homes whose daemons live in those homes.
//  The bare-boot
//  byte-identical proof and the first-birth proof.
//
//   D1  THE BARE BOOT WRITES NOTHING (law 2): booting in a fresh folder,
//       looking at the boot menu and leaving keeps the folder byte-identical
//       (a content hash of the whole tree before/after — the poison is any
//       write), creates no `.mercury/`, no session-store dir for the folder
//       and no cost/session/metrics row under the folder in the global
//       config (the seeded trust grant and the git-history hint cache are
//       the named, tolerated footprints); the face names the folder without
//       history ("New Session in foo");
//   D2  THE FIRST CHAT INITIALIZES THE CATALOG (law 3): ↵ on New Session
//       (the warm road) creates exactly `<folder>/.mercury/` (an empty
//       directory) and the project card beside the store's transcripts —
//       with no transcript yet (no words) — and a boot from ANOTHER folder
//       on the same home lists the folder on the Boot face's project row;
//   D3  THE .mercury-PARENT NAMING (law 1 + law 4): booting inside
//       `gamma/.mercury` names the project "gamma" and, being a bare boot,
//       writes nothing there either.
// ============================================================================
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

// ── the scratch estate (BEFORE any product import) ──────────────────────────
const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'mercury-folderproj-')))
const TEMPLATE = join(SCRATCH, 'home-template')
const FOO = join(SCRATCH, 'foo')
const OTHER = join(SCRATCH, 'other')
const GAMMA_MERC = join(SCRATCH, 'gamma', '.mercury')
for (const d of [TEMPLATE, FOO, OTHER, GAMMA_MERC]) mkdirSync(d, { recursive: true })
writeFileSync(join(FOO, 'README.md'), '# foo\n')
mkdirSync(join(FOO, 'src'))
writeFileSync(join(FOO, 'src', 'app.txt'), 'hello\n')
writeFileSync(join(OTHER, 'notes.txt'), 'other\n')
// A real git history exercises the whole interactive boot graph (the
// example-files gatherer runs `git log` in a repo); a box without git boots
// the folder plain. `.git/` is git's own bookkeeping (status refreshes the
// index) and is excluded from the hash by name.
const gitOk = (() => {
  const run = (args: string[]): boolean => spawnSync('git', args, { cwd: FOO, stdio: 'ignore' }).status === 0
  return (
    run(['init', '-q']) &&
    run(['-c', 'user.email=proof@example.invalid', '-c', 'user.name=proof', 'add', '.']) &&
    run(['-c', 'user.email=proof@example.invalid', '-c', 'user.name=proof', 'commit', '-q', '-m', 'seed'])
  )
})()
process.env.MERCURY_CONFIG_DIR = TEMPLATE
process.env.ANTHROPIC_API_KEY = 'fixture-key-000'
delete process.env.NODE_ENV
delete process.env.CI
delete process.env.MERCURY_DAEMON_DIR
delete process.env.MERCURY_CONCOURSE

const REPO = join(import.meta.dir, '..', '..')
const BIN = join(REPO, 'dist', 'mercury.mjs')
const CAPTURE_DIR = process.env.MERCURY_FOLDERPROJ_CAPTURE_DIR ?? null
if (CAPTURE_DIR) mkdirSync(CAPTURE_DIR, { recursive: true })
if (!existsSync(BIN)) {
  console.error('✗ dist/mercury.mjs missing — run `bun run build.ts` first')
  process.exit(1)
}

const { seedFirstRun } = await import('../lib/firstRunSeed.ts')
const { resolveCaptureDriver } = await import('../lib/captureDriver.ts')
const { startFixtureApi } = await import('../lib/fixtureApi.ts')
const { readSessionWorkers } = await import('../../src/daemon/concourseSupervisor.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

const driver = resolveCaptureDriver()
if (driver.kind !== 'posix-pty') {
  console.error(`prove-folder-project-drive: capture driver unavailable — ${driver.kind === 'unavailable' ? `${driver.reason}; ${driver.remedy}` : driver.kind}`)
  process.exit(1)
}

// The trust grant is the ONE write the trust law requires of a first boot;
// seeding it (absent-only) keeps the bare-boot diff about everything else.
seedFirstRun(TEMPLATE, [FOO, OTHER, GAMMA_MERC])

/** The face's canon ready line (the boot menu is on screen). */
const READY_LINE = '↵ start  ·  m menu  ·  ↑↓ choose'
/** The composer's placeholder (a chat is on screen). */
const COMPOSER = 'Type a prompt'
/** Ticks the face waits before ↵ so the daemon pre-warm and its warm
 *  runner are up behind the face. */
const WARM_TICKS = 25
/** The folder's per-project record may carry exactly these keys after a
 *  bare boot: the seeded trust grant + onboarding mark, and the git-history
 *  hint cache the interactive boot graph refreshes (reported, tolerated). */
// permissionPosture: trust WI-12's audit composition record — the boot
// dialog decision durably names what armed the posture (mode · armedBy ·
// consentDialog · trustDialogAccepted · recordedAtMs); an audit row, never a
// cost/session/metrics leak.
const TOLERATED_PROJECT_KEYS = new Set(['hasTrustDialogAccepted', 'hasCompletedProjectOnboarding', 'exampleFiles', 'exampleFilesGeneratedAt', 'permissionPosture'])

type Send = Record<string, unknown>
type Capture = { home: string; text: string; lines: string[]; status: number; tail: string; payload: Record<string, unknown> }

function freshHome(id: string): string {
  const home = join(SCRATCH, `home-${id}`)
  cpSync(TEMPLATE, home, { recursive: true })
  return home
}

/** A content hash of a directory tree — names + bytes, every depth;
 *  `.git/` (git's own bookkeeping) excluded by name. */
function treeHash(root: string): string {
  const rows: string[] = []
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      if (name === '.git') continue
      const p = join(dir, name)
      const st = statSync(p)
      if (st.isDirectory()) {
        rows.push(`d ${relative(root, p)}`)
        walk(p)
      } else {
        rows.push(`f ${relative(root, p)} ${createHash('sha256').update(readFileSync(p)).digest('hex')}`)
      }
    }
  }
  walk(root)
  return createHash('sha256').update(rows.join('\n')).digest('hex')
}

async function capture(opts: { id: string; home: string; cwd: string; argv?: string[]; sends: Send[]; ready?: string; total?: number; stableTicks?: number }): Promise<Capture> {
  const api = await startFixtureApi([{ kind: 'text', text: 'Spare.' }, { kind: 'text', text: 'Spare.' }])
  const cfgPath = join(SCRATCH, `cfg-${opts.id}.json`)
  const outPath = join(SCRATCH, `grid-${opts.id}.json`)
  writeFileSync(
    cfgPath,
    JSON.stringify({
      argv: ['node', BIN, '--model', 'claude-sonnet-5', ...(opts.argv ?? [])],
      cwd: opts.cwd,
      cols: 120,
      rows: 40,
      sends: opts.sends,
      ...(opts.ready !== undefined ? { readyText: opts.ready, readySettleTicks: 3 } : {}),
      ...(opts.stableTicks !== undefined ? { stableTicks: opts.stableTicks } : {}),
      total: opts.total ?? 300,
      out: outPath,
    }),
  )
  const child = spawn(driver.python, [join(REPO, 'scripts', 'ui', 'vshot.py'), cfgPath], {
    env: {
      ...process.env,
      MERCURY_CONFIG_DIR: opts.home,
      MERCURY_LIVE_GLYPHS: '0',
      ANTHROPIC_API_KEY: 'fixture-key-000',
      ANTHROPIC_BASE_URL: api.url,
      MERCURY_CACHE_CLOCK: '0',
      MERCURY_PARTY: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const result = await new Promise<Capture>(resolvePromise => {
    let tail = ''
    child.stdout.on('data', d => (tail = (tail + String(d)).slice(-600)))
    child.stderr.on('data', d => (tail = (tail + String(d)).slice(-600)))
    child.on('close', status => {
      let text = ''
      let lines: string[] = []
      let payload: Record<string, unknown> = {}
      try {
        payload = JSON.parse(readFileSync(outPath, 'utf8')) as Record<string, unknown>
        const grid = payload.grid as Array<Array<{ c: string }>>
        lines = grid.map(row => row.map(cell => cell.c).join(''))
        text = lines.join('\n')
        if (CAPTURE_DIR) {
          writeFileSync(join(CAPTURE_DIR, `${opts.id}.txt`), lines.map(l => l.replace(/\s+$/, '')).join('\n') + '\n')
          for (const mark of (payload.marks as Array<{ label: string; grid: Array<Array<{ c: string }>> }> | undefined) ?? []) {
            writeFileSync(join(CAPTURE_DIR, `${opts.id}--${mark.label}.txt`), mark.grid.map(row => row.map(cell => cell.c).join('').replace(/\s+$/, '')).join('\n') + '\n')
          }
        }
      } catch {
        // grid missing — the status/tail carry the reason
      }
      resolvePromise({ home: opts.home, text, lines, status: status ?? 1, tail, payload })
    })
  })
  try {
    await api.close()
  } catch {
    /* the fixture is per capture */
  }
  return result
}

function markText(c: Capture, label: string): string {
  const marks = (c.payload.marks as Array<{ label: string; grid: Array<Array<{ c: string }>> }> | undefined) ?? []
  return (marks.find(m => m.label === label)?.grid ?? []).map(row => row.map(cell => cell.c).join('')).join('\n')
}

function printFrame(id: string, lines: string[]): void {
  console.log(`\n┌── ${id} ──`)
  for (const l of lines) console.log(`│${l.replace(/\s+$/, '')}`)
  console.log('└──')
}

const recordsOf = (home: string): ReturnType<typeof readSessionWorkers> => readSessionWorkers(join(home, 'daemon'))
const liveRecords = (home: string): ReturnType<typeof readSessionWorkers> =>
  Object.fromEntries(Object.entries(recordsOf(home)).filter(([, r]) => r.endedAt === undefined))

/** The store dirs under the home that name `dir` — by card or by a
 *  transcript head. */
function storeDirsFor(home: string, dir: string): string[] {
  const root = join(home, 'projects')
  if (!existsSync(root)) return []
  const out: string[] = []
  for (const d of readdirSync(root)) {
    const pdir = join(root, d)
    let names: string[]
    try {
      names = readdirSync(pdir)
    } catch {
      continue
    }
    if (names.includes('project.json')) {
      try {
        const card = JSON.parse(readFileSync(join(pdir, 'project.json'), 'utf8')) as { dir?: string }
        if (card.dir === dir) {
          out.push(pdir)
          continue
        }
      } catch {
        /* not a card */
      }
    }
    for (const f of names) {
      if (!f.endsWith('.jsonl')) continue
      if (readFileSync(join(pdir, f), 'utf8').slice(0, 4096).includes(JSON.stringify(dir))) {
        out.push(pdir)
        break
      }
    }
  }
  return out
}

function transcriptsOf(home: string): string[] {
  const root = join(home, 'projects')
  if (!existsSync(root)) return []
  const out: string[] = []
  for (const project of readdirSync(root)) {
    const pdir = join(root, project)
    for (const f of readdirSync(pdir)) if (f.endsWith('.jsonl')) out.push(join(pdir, f))
  }
  return out
}

function projectRecord(home: string, dir: string): Record<string, unknown> | null {
  try {
    const cfg = JSON.parse(readFileSync(join(home, '.mercury.json'), 'utf8')) as { projects?: Record<string, Record<string, unknown>> }
    return cfg.projects?.[dir] ?? null
  } catch {
    return null
  }
}

/** Reap the home's daemon + children so the scratch never leaks processes. */
function reapHome(home: string): void {
  for (const rec of Object.values(recordsOf(home))) {
    if (rec.pid !== undefined) {
      try {
        process.kill(rec.pid, 'SIGTERM')
      } catch {
        /* gone */
      }
    }
  }
  try {
    const pidFile = join(home, 'daemon', 'daemon.pid')
    if (existsSync(pidFile)) {
      const pid = Number(readFileSync(pidFile, 'utf8').trim())
      if (Number.isInteger(pid) && pid > 0) process.kill(pid, 'SIGTERM')
    }
  } catch {
    /* gone */
  }
}

const g = (needle: string, data: string, extra: Send = {}): Send => ({ atTick: 999, requireAwait: true, awaitText: needle, minTick: 5, awaitSettleTicks: 2, data, ...extra })
/** Leave the product the way an operator does: ctrl+c twice (the exit
 *  chord), a ctrl+d pair as the fallback for a surface without it — so the
 *  exit-time flushes run and their footprint can be judged. */
const QUIT: Send[] = [
  { afterPrevTicks: 3, data: '\x03' },
  { afterPrevTicks: 2, data: '\x03' },
  { afterPrevTicks: 4, data: '\x04' },
  { afterPrevTicks: 2, data: '\x04' },
]

// ── D1: the bare boot writes nothing ────────────────────────────────────────
console.log(`D1 — a bare boot in a fresh folder writes nothing (${gitOk ? 'a git repo with one commit' : 'a plain folder — git unavailable'})`)
{
  const home = freshHome('bare')
  const before = treeHash(FOO)
  const c = await capture({
    id: 'd1-bare-boot',
    home,
    cwd: FOO,
    sends: [g(READY_LINE, '', { mark: 'face' }), { afterPrevTicks: WARM_TICKS, data: '', mark: 'settled' }, ...QUIT],
    stableTicks: 6,
    total: 200,
  })
  printFrame('d1 (the face, then the exit)', c.lines)
  const face = markText(c, 'face')
  check('D1 the boot landed on the face', face.includes('New Session'), face.slice(0, 160))
  check('D1 the face names the folder without history ("New Session in foo")', face.includes('New Session in foo'), face.split('\n').filter(l => l.includes('New Session')).join(' | '))
  check('D1 the folder is byte-identical after the boot (the poison: any write)', treeHash(FOO) === before)
  check('D1 no `.mercury/` was created in the folder', !existsSync(join(FOO, '.mercury')))
  check('D1 no session-store dir names the folder (no card, no transcript)', storeDirsFor(home, FOO).length === 0, storeDirsFor(home, FOO).join(','))
  check('D1 no session was born behind the face (the warm runner keeps no record)', Object.keys(liveRecords(home)).length === 0 && transcriptsOf(home).length === 0)
  const rec = projectRecord(home, FOO) ?? {}
  const extra = Object.keys(rec).filter(k => !TOLERATED_PROJECT_KEYS.has(k))
  check('D1 the folder\'s config record carries only the tolerated keys (no cost row, no session id, no metrics)', extra.length === 0, `extra: ${extra.join(',') || '∅'} · status ${c.status}`)
  console.log(`  [FOOTPRINT] config record keys after the bare boot: ${Object.keys(rec).join(', ') || '∅'} (exit status ${c.status})`)
  reapHome(home)
}

// ── D2: the first chat initializes the catalog ──────────────────────────────
console.log('D2 — ↵ on New Session initializes `.mercury/` + the project card; the folder lists from another folder')
{
  const home = freshHome('birth')
  const before = treeHash(FOO)
  const c = await capture({
    id: 'd2-first-chat',
    home,
    cwd: FOO,
    sends: [g(READY_LINE, '', { mark: 'face' }), { afterPrevTicks: WARM_TICKS, data: '\r', mark: 'enter' }, g(COMPOSER, '', { mark: 'chat', awaitSettleTicks: 4 })],
    ready: COMPOSER,
    total: 200,
  })
  printFrame('d2 (the chat after ↵)', c.lines)
  check('D2 the chat is on screen after ↵', c.text.includes(COMPOSER), c.tail.slice(-200))
  const estate = join(FOO, '.mercury')
  check('D2 the first birth created exactly `<folder>/.mercury/`', existsSync(estate) && statSync(estate).isDirectory(), c.tail.slice(-120))
  check('D2 the estate is an empty directory (nothing speculative inside)', existsSync(estate) && readdirSync(estate).length === 0, existsSync(estate) ? readdirSync(estate).join(',') : 'absent')
  rmSync(estate, { recursive: true, force: true })
  check('D2 beyond the estate the folder is byte-identical (the birth wrote nothing else)', treeHash(FOO) === before)
  const stores = storeDirsFor(home, FOO)
  check('D2 the project card sits in the folder\'s session-store dir', stores.length === 1 && existsSync(join(stores[0]!, 'project.json')), stores.join(','))
  if (stores.length === 1) {
    const card = JSON.parse(readFileSync(join(stores[0]!, 'project.json'), 'utf8')) as Record<string, unknown>
    const live = Object.values(liveRecords(home))
    check('D2 the card names the folder and the born session', card.schema === 1 && card.dir === FOO && typeof card.firstChatAt === 'number' && live.some(r => r.sessionId === card.firstSessionId), JSON.stringify(card))
    check('D2 the born session works in the folder (the record\'s workspace)', live.length === 1 && live[0]?.workspaceId === realpathSync(FOO), JSON.stringify(live.map(r => r.workspaceId)))
  }
  check('D2 no transcript yet — the first chat is wordless', transcriptsOf(home).length === 0, transcriptsOf(home).join(','))
  reapHome(home)
  // A boot from ANOTHER folder on the same home lists foo on the face.
  const d = await capture({
    id: 'd2b-listed-from-other',
    home,
    cwd: OTHER,
    sends: [g(READY_LINE, '', { mark: 'face', awaitSettleTicks: 4 })],
    ready: READY_LINE,
    stableTicks: 4,
    total: 120,
  })
  printFrame('d2b (the face from another folder)', d.lines)
  const face = markText(d, 'face')
  check('D2 the other folder is named as itself', face.includes('New Session in other'))
  // The face's Sessions · Projects row counts the catalogued repos ("1 repo ·
  // pick a session") — the picker behind it names them; the count is the
  // face's word for "foo is a project now".
  check('D2 foo is a selectable project now — the face\'s project row counts it (the one list; no transcript needed)', /\b[1-9]\d* repos? · pick a session/.test(face.replace(/\n/g, ' ')), face.split('\n').filter(l => /Project/.test(l)).join(' | '))
  check('D2 foo\'s wordless chat is never a Continue target', !face.includes('Continue Last Session'), face.split('\n').filter(l => l.includes('Continue')).join(' | '))
  reapHome(home)
}

// ── D3: the .mercury-parent naming, bare ────────────────────────────────────
console.log('D3 — booting inside `gamma/.mercury` names the project "gamma" and writes nothing')
{
  const home = freshHome('gamma')
  const before = treeHash(GAMMA_MERC)
  const c = await capture({
    id: 'd3-dot-mercury-cwd',
    home,
    cwd: GAMMA_MERC,
    sends: [g(READY_LINE, '', { mark: 'face', awaitSettleTicks: 4 }), ...QUIT],
    stableTicks: 4,
    total: 120,
  })
  printFrame('d3 (the face inside gamma/.mercury)', c.lines)
  const face = markText(c, 'face')
  check('D3 the face names the parent folder ("New Session in gamma"), never the dot-dir', face.includes('New Session in gamma') && !face.includes('New Session in .mercury'), face.split('\n').filter(l => l.includes('New Session')).join(' | '))
  check('D3 the bare boot left the dot-dir byte-identical (no nested home)', treeHash(GAMMA_MERC) === before && !existsSync(join(GAMMA_MERC, '.mercury')))
  reapHome(home)
}

if (process.env.MERCURY_FOLDERPROJ_KEEP !== '1') rmSync(SCRATCH, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-folder-project-drive: ALL LAWS HOLD' : `\nprove-folder-project-drive: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
