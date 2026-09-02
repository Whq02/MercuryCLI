#!/usr/bin/env bun
// ============================================================================
//  scripts/journey/prove-apollo-consent-journey.ts — the Apollo closing
//  consent driven end-to-end on the REAL binary, one drive per ruled answer
//  (the K2 trap: plain yes left the session in Apollo Mode and the agent
//  stalled with its edits refused; no way to answer "keep interviewing").
//
//  Each drive: a scripted Anthropic backend runs interview → clean review;
//  the PTY answers the consent card differently per branch:
//    A  build            plain yes — the mode MOVES (gate closed here, so
//                        the ruled posture is implement); the next Write
//                        ACTS with no ask; the run finishes
//    B  build-ask-first  the mode MOVES to default; the next Write ASKS
//                        (the per-edit breadth), one approval lands it;
//                        the run finishes
//    C  more-questions   nothing moves — the apollo band stays, the
//                        interview RESUMES with poll 2, the session lives
//
//  The auto gate is closed via settings (disableAutoMode) so branch A is
//  deterministic and classifier-free; the flow arm of the ruled posture is
//  pinned behaviorally by scripts/apollo/prove-apollo-mode.ts §6.
//
//  Run:  ~/.bun/bin/bun run scripts/journey/prove-apollo-consent-journey.ts
//        [branch] [cols]     branch ∈ build|build-ask-first|more-questions
//                            (argless: all three at 100 cols)
//  Out:  grid JSONs + text dumps under the drive's scratch world; kept on
//        failure for forensics.
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

const REPO = path.resolve(import.meta.dir, '../..')
const DIST = path.join(REPO, 'dist/mercury.mjs')
const VSHOT = path.join(REPO, 'scripts/ui/vshot.py')
const BUN = process.env.BUN ?? path.join(process.env.HOME ?? '', '.bun/bin/bun')

const FINAL_TEXT = 'APOLLO JOURNEY DONE: the prototype slice is written'
const RESUME_TEXT = 'INTERVIEW RESUMED: noting the second answer in the spec'
const POLL_ONE_FRAGMENT = 'the output — console or page'
const POLL_TWO_FRAGMENT = 'the look — palette'
const CARD_QUESTION = 'Begin the prototype build?'
const SESSION_TIER_LABEL = 'Yes, allow all edits'

type Branch = 'build' | 'build-ask-first' | 'more-questions'
const ALL_BRANCHES: Branch[] = ['build', 'build-ask-first', 'more-questions']

let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

if (!existsSync(DIST)) {
  console.log('FAIL dist/mercury.mjs missing — run `bun run build.ts` first (the drive proves the BUILT binary)')
  process.exit(1)
}

const argBranch = process.argv[2] as Branch | undefined
const argCols = Number(process.argv[3] ?? '100')
if (argBranch !== undefined && !ALL_BRANCHES.includes(argBranch)) {
  console.log(`FAIL unknown branch ${argBranch}`)
  process.exit(1)
}
const branches: Branch[] = argBranch ? [argBranch] : ALL_BRANCHES

async function driveBranch(branch: Branch, cols: number): Promise<void> {
  section(`branch ${branch} @ ${cols} cols`)

  // ── the hermetic world ────────────────────────────────────────────────
  // The config home and the project are SIBLINGS: a project nested inside
  // MERCURY_CONFIG_DIR would make every project file read as the config
  // estate and swap the file dialog's session tier for the settings one.
  const WORLD = path.join(realpathSync(tmpdir()), `mercury-apollok2-${branch}-${cols}-${process.pid}`)
  const RUN_HOME = path.join(WORLD, 'home')
  const FIXTURE_CWD = path.join(WORLD, 'fixture-repo')
  const PROBE_KEY = 'sk-ant-apollok2-probe-key'
  rmSync(WORLD, { recursive: true, force: true })
  mkdirSync(RUN_HOME, { recursive: true })
  mkdirSync(FIXTURE_CWD, { recursive: true })
  writeFileSync(
    path.join(RUN_HOME, '.mercury.json'),
    JSON.stringify({
      hasCompletedOnboarding: true,
      lastOnboardingVersion: '99.0.0',
      numStartups: 10,
      theme: 'dark',
      projects: { [FIXTURE_CWD]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } },
      customApiKeyResponses: { approved: [PROBE_KEY.slice(-20)], rejected: [] },
    }),
  )
  // The auto gate CLOSED: plain yes lands implement deterministically (the
  // gate-off arm of the ruled posture; no classifier in the world).
  writeFileSync(
    path.join(RUN_HOME, 'settings.json'),
    JSON.stringify({ permissions: { disableAutoMode: 'disable' } }),
  )

  // ── the fixture server (its own process) ──────────────────────────────
  const captureFile = path.join(RUN_HOME, 'wire-captures.jsonl')
  writeFileSync(captureFile, '')
  const fixture = spawn(
    BUN,
    ['run', path.join(import.meta.dir, 'apollo-consent-fixture-server.ts'), captureFile, FIXTURE_CWD, branch],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )
  const port = await new Promise<number>((resolve, reject) => {
    const killer = setTimeout(() => reject(new Error('fixture server never printed PORT')), 15_000)
    let buffer = ''
    fixture.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      const m = /PORT (\d+)/.exec(buffer)
      if (m) {
        clearTimeout(killer)
        resolve(Number(m[1]))
      }
    })
    fixture.on('exit', code => reject(new Error(`fixture server exited early (${code})`)))
  }).catch(err => {
    console.log(`FAIL ${String(err)}`)
    process.exit(1)
  })
  const base = `http://127.0.0.1:${port}`

  try {
    // ── the PTY drive ───────────────────────────────────────────────────
    const cardSelect: Record<Branch, string> = {
      build: '\r',
      'build-ask-first': '\x1b[B\r',
      'more-questions': '\x1b[B\x1b[B\r',
    }
    // awaitSettleTicks on every consent-answering send: paint ≠ input-wired —
    // a key sent the same tick a surface first paints can be swallowed by the
    // not-yet-focused select (the vshot settled-phase law).
    // The card send awaits the FOCUSED select row ('❯ 1. Yes…'), not the ask
    // text — the ask message can paint in a queued, unfocused state where a
    // key would fall into the composer (the queued-overlay class); the
    // pointer row exists only once the dialog's select is mounted. Every
    // consent-answering send also settles a few ticks past first paint
    // (paint ≠ input-wired) and carries a mark so the fire tick is in the
    // output JSON for forensics.
    const sends: Array<Record<string, unknown>> = [
      // THE LANDING RULE: a bare boot lands on the Boot face — ↵ on New Session enters the chat first.
      { atTick: 40, awaitText: '↑↓ choose', minTick: 3, awaitSettleTicks: 2, data: '\r' },
      { requireAwait: true, minTick: 10, awaitText: '? for shortcuts', data: 'build me a tiny hello demo\r', mark: 'directive' },
      { requireAwait: true, minTick: 6, awaitText: POLL_ONE_FRAGMENT, awaitSettleTicks: 3, data: '\r', mark: 'poll1-answer' },
      { requireAwait: true, minTick: 6, awaitText: '❯ 1. Yes — begin the build', awaitSettleTicks: 4, data: cardSelect[branch], mark: 'card-answer' },
    ]
    if (branch === 'build-ask-first') {
      // The per-edit ask IS the breadth on trial: this send fires only if
      // the create-file consent really appears (requireAwait — a missing
      // dialog is a loud exit, not a silent pass), and plain Yes lands it.
      sends.push({ requireAwait: true, minTick: 6, awaitText: SESSION_TIER_LABEL, awaitSettleTicks: 4, data: '\r', mark: 'write-approve' })
    }
    if (branch === 'more-questions') {
      // Poll 2 appearing IS the resumed interview; answer it to prove the
      // session still flows to a normal turn.
      sends.push({ requireAwait: true, minTick: 6, awaitText: POLL_TWO_FRAGMENT, awaitSettleTicks: 3, data: '\r', mark: 'poll2-answer' })
    }
    const out = path.join(RUN_HOME, `grid-${branch}-${cols}.json`)
    const cfg = {
      argv: ['node', DIST, '--permission-mode', 'apollo'],
      cwd: FIXTURE_CWD,
      sends,
      readyText: [branch === 'more-questions' ? RESUME_TEXT : FINAL_TEXT],
      stableTicks: 4,
      total: 240,
      cols,
      rows: 40,
      out,
    }
    const cfgPath = path.join(RUN_HOME, `cfg-${branch}-${cols}.json`)
    writeFileSync(cfgPath, JSON.stringify(cfg))

    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      MERCURY_CONFIG_DIR: RUN_HOME,
      ANTHROPIC_API_KEY: PROBE_KEY,
      ANTHROPIC_BASE_URL: base,
      OPENAI_API_KEY: 'sk-test-apollok2-openai',
      MERCURY_OPENAI_API_BASE: `${base}/openai/v1`,
      MERCURY_LOCAL_PROBE_TARGETS: 'none',
      MERCURY_BOOT_PREFLIGHT: '0',
      MERCURY_LIVE_GLYPHS: '0',
      MERCURY_CRITTER_GAZE: '0',
      MERCURY_DECK_COMPANION: '0',
      MERCURY_TURN_RECEIPT: '0',
      MERCURY_VERIFY_EVIDENCE: '0',
      MERCURY_DOCTOR_STATE_DIR: path.join(RUN_HOME, 'doctor-state'),
      MERCURY_DAEMON_DIR: path.join(RUN_HOME, 'daemon'),
      MERCURY_TEAMS_DIR: path.join(RUN_HOME, 'teams'),
      MERCURY_TABULA_DIR: path.join(RUN_HOME, 'tabula'),
      MERCURY_TABULA_MINERVA: '0',
      MERCURY_HOME: path.join(RUN_HOME, 'proof-home'),
    }
    delete childEnv.NODE_ENV
    delete childEnv.ANTHROPIC_AUTH_TOKEN

    const res = spawnSync('/usr/bin/python3', [VSHOT, cfgPath], {
      encoding: 'utf-8',
      timeout: vshotBudgetMs(260_000),
      cwd: FIXTURE_CWD,
      env: childEnv,
    })
    let gridText = ''
    if (existsSync(out)) {
      const payload = JSON.parse(readFileSync(out, 'utf8')) as {
        grid: Array<Array<{ c: string }>>
        marks?: Array<{ label: string; grid: Array<Array<{ c: string }>> }>
      }
      const toText = (grid: Array<Array<{ c: string }>>): string =>
        grid.map(r => r.map(c => c.c || ' ').join('')).join('\n')
      gridText = toText(payload.grid)
      writeFileSync(path.join(RUN_HOME, `grid-${branch}-${cols}.txt`), gridText)
      // The eyeball set: each mark's grid (the card, the dialogs) plus the
      // final frame, kept under MERCURY_K2_CAPTURE_DIR when it is set.
      const keepDir = process.env.MERCURY_K2_CAPTURE_DIR
      if (keepDir) {
        mkdirSync(keepDir, { recursive: true })
        for (const mark of payload.marks ?? []) {
          writeFileSync(path.join(keepDir, `${branch}-${cols}-${mark.label}.txt`), toText(mark.grid))
        }
        writeFileSync(path.join(keepDir, `${branch}-${cols}-final.txt`), gridText)
      }
    }
    type Capture = { kind: string; n?: number; body?: Record<string, unknown>; at: number }
    const wire: Capture[] = readFileSync(captureFile, 'utf8')
      .split('\n')
      .filter(l => l.trim() !== '')
      .map(l => JSON.parse(l) as Capture)
    const anthropic = wire.filter(c => c.kind === 'anthropic').sort((a, b) => (a.n ?? 0) - (b.n ?? 0))
    const bodyOf = (c: Capture | undefined): string => JSON.stringify(c?.body ?? {})
    const wire3 = bodyOf(anthropic[2])
    const helloExists = existsSync(path.join(FIXTURE_CWD, 'hello.js'))

    check('the drive completed (vshot exit 0 — every awaited surface appeared)', res.status === 0, `status=${res.status} tail=${(res.stdout ?? '').split('\n').slice(-4).join(' | ')}`)
    check('four model calls — interview, review, action, finish', anthropic.length >= 4, `calls=${anthropic.length}`)
    check(
      "the ApolloReview schema shipped on the wire roster (no discovery round-trip in apollo)",
      bodyOf(anthropic[0]).includes('"ApolloReview"'),
    )

    if (branch === 'build') {
      check('plain yes: the review result says the build begins under Implement Mode', wire3.includes('build begins NOW') && wire3.includes('The session moved to Implement Mode'), wire3.slice(0, 400))
      check('plain yes: the next Write ACTED — the prototype file exists with no ask', helloExists)
      check('plain yes: no file consent appeared (the mode carries the edits)', !gridText.includes(SESSION_TIER_LABEL))
      check('plain yes: the apollo band is GONE (the mode really moved)', !gridText.includes('apollo mode on'))
      check('plain yes: the implement band paints', gridText.includes('implement mode on'), gridText.split('\n').slice(0, 3).join(' | '))
      check('plain yes: the run finished', gridText.includes(FINAL_TEXT))
    } else if (branch === 'build-ask-first') {
      check('ask-first: the review result names the per-edit consent', wire3.includes('build begins NOW') && wire3.includes('The session moved to Default') && wire3.includes('each edit will ask'), wire3.slice(0, 400))
      check('ask-first: the Write ASKED and one approval landed it', helloExists)
      check('ask-first: the apollo band is GONE (the mode moved to default)', !gridText.includes('apollo mode on'))
      check('ask-first: no implement band (default paints no band — breadth stayed narrow)', !gridText.includes('implement mode on'))
      check('ask-first: the run finished', gridText.includes(FINAL_TEXT))
    } else {
      check('more-questions: the review result speaks the discuss grammar', wire3.includes('asked for more questions') && wire3.includes('Resume the interview'), wire3.slice(0, 400))
      check('more-questions: NOTHING was written (the build never started)', !helloExists)
      check('more-questions: the apollo band STAYS (state preserved)', gridText.includes('apollo mode on'), gridText.split('\n').slice(0, 3).join(' | '))
      check('more-questions: the interview resumed — poll 2 was answered and the turn flowed', gridText.includes(RESUME_TEXT))
    }

    if (failures === 0) {
      rmSync(WORLD, { recursive: true, force: true })
    } else {
      console.log(`[forensics] world kept: ${WORLD}`)
    }
  } finally {
    try {
      fixture.kill('SIGTERM')
    } catch {
      /* already gone */
    }
  }
}

console.log('============================================================')
console.log(' Apollo closing consent LIVE — three answers, three postures')
console.log('============================================================')

for (const branch of branches) {
  await driveBranch(branch, argCols)
}

console.log(`\n ${checks} checks, ${failures} failures`)
process.exit(failures === 0 ? 0 : 1)
