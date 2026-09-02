#!/usr/bin/env bun
// ============================================================================
//  scripts/operator-identity/prove-coordination-modes-retired.ts — the
//  stays-deleted ratchet for the two retired coordination modes: the
//  two-seat foreground/daemon mode and the router party.
//
//  The estate left the tree whole: its source, its proof suites, its flag
//  rows, its seat roles, its sentinel, its notification keys, its team and
//  agent names, its nameplates, its commands and its permission-mode member.
//  What stayed is EXACTLY the shared mechanisms named in §6, each with its
//  live consumer — the kept envs took neutral names; the bus envelope writes
//  a neutral protocol type and reads the retired one for persisted files.
//
//  RED on: a deleted path reappearing (§1); a deleted flag spelled anywhere
//  in src, scripts, docs or the README (§2); the seat roles, the sentinel or
//  the notification key spelled anywhere (§3); the party's team/agent names
//  or the nameplates spelled anywhere (§4); a retired command door back in
//  the registry, or its spelling back on a doc page (§5); a kept mechanism
//  losing its consumer (§6 — the survivors are pinned present, not absent).
//
//  Every needle is COMPOSED at runtime so this file never matches itself.
//
//  Run:  ~/.bun/bin/bun run scripts/operator-identity/prove-coordination-modes-retired.ts
// ============================================================================
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const SELF = relative(ROOT, join(import.meta.dir, 'prove-coordination-modes-retired.ts'))

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const J = (...parts: string[]): string => parts.join('')
const exists = (rel: string): boolean => {
  try {
    statSync(join(ROOT, rel))
    return true
  } catch {
    return false
  }
}

// ── the text census ─────────────────────────────────────────────────────────

const TEXT_EXT = /\.(ts|tsx|js|mjs|cjs|sh|json|md|py|tsv|txt|yml|yaml|ps1|cmd)$/
const SKIP_DIRS = new Set(['node_modules', 'vendor', 'dist', '.git', J('clean', 'room')])

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) yield* walk(full)
    else if (TEXT_EXT.test(name)) yield full
  }
}

/** Every text file the ratchet reads: src, scripts, docs and the README. */
function* censusFiles(): Generator<[string, string]> {
  for (const top of ['src', 'scripts', 'docs']) {
    if (!exists(top)) continue
    for (const abs of walk(join(ROOT, top))) {
      const rel = relative(ROOT, abs)
      if (rel === SELF) continue
      yield [rel, readFileSync(abs, 'utf8')]
    }
  }
  if (exists('README.md')) yield ['README.md', readFileSync(join(ROOT, 'README.md'), 'utf8')]
}
const CENSUS: Array<[string, string]> = [...censusFiles()]

/** Files carrying a needle (as a regex), with the first matching line. */
function carriers(needle: RegExp): string[] {
  const out: string[] = []
  for (const [rel, text] of CENSUS) {
    const m = needle.exec(text)
    if (m) {
      const line = text.slice(0, m.index).split('\n').length
      out.push(`${rel}:${line}`)
    }
  }
  return out
}

console.log('============================================================')
console.log(' the retired coordination modes stay retired')
console.log('============================================================')

// ── §1 the deleted paths stay gone ──────────────────────────────────────────
{
  const S = J('scri', 'be')
  const I = J('implem', 'enter')
  const DELETED_PATHS = [
    J('src/utils/', S, '/'),
    J('src/utils/', S, 'Mode.ts'),
    J('src/utils/', I, 'Mode.ts'),
    J('src/memdir/', S, 'Promote.ts'),
    J('src/memdir/', S, 'ScopeDoctrine.ts'),
    J('src/components/', 'Scri', 'beCandidatesView.tsx'),
    J('src/components/mercury-ui/', S, 'ChatTabs.ts'),
    J('src/components/mercury-ui/screens/', 'ChatTranscript', 'View.tsx'),
    J('src/commands/', 'chat/'),
    J('src/commands/', 'all/'),
    J('src/commands/', 'batch/'),
    J('src/commands/', S, '-promote/'),
    J('src/utils/hooks/', S, 'DispatchGate.ts'),
    J('src/utils/hooks/', S, 'ImplementerHooks.ts'),
    J('src/utils/hooks/', S, 'ImplementerStopHook.ts'),
    J('src/utils/hooks/', 'unfinished', 'Tail.ts'),
    J('src/utils/router/adapters/', S, '.ts'),
    J('src/utils/router/', 'routePack', 'Sections.ts'),
    J('src/utils/cockpit/', 'crewChat', 'Rows.ts'),
    J('src/utils/model/', 'seatSlot', 'Store.ts'),
    J('src/utils/model/', 'operator', 'Reslot.ts'),
    J('src/daemon/', S, 'DispatchBridge.ts'),
    J('src/tools/SendMessageTool/', 'routePlan', 'Ops.ts'),
    J('scripts/', S, '/'),
    J('scripts/', 'seat-', 'slots/'),
    J('scripts/substrate/probe-', S, '-roundtrip.ts'),
    J('scripts/journey/prove-muster-', 'reslot', '-journey.ts'),
    J('scripts/journey/muster-', 'fixture', '-daemon.ts'),
    J('scripts/router/prove-dispatch-', 'compat', '.ts'),
    J('scripts/router/prove-', S, '-route-flow.ts'),
    J('scripts/router/corpus/compiler/legacy-', 'envelope', '-effort-only.json'),
    J('scripts/memory/prove-promote-', 'rungate', '-wire.ts'),
    J('scripts/ui/prove-crew-', 'chat', '.ts'),
    J('scripts/ui/prove-chat-', 'epoch', '.ts'),
    J('scripts/model-routing/prove-gpt-', 'seat', '-rows.ts'),
    J('scripts/model-routing/live/', 'compositions', '.sh'),
  ]
  const back = DELETED_PATHS.filter(exists)
  check(`§1 none of the ${DELETED_PATHS.length} deleted paths reappeared`, back.length === 0, back.join(', '))
}

// ── §2 the deleted flags are spelled nowhere ────────────────────────────────
{
  const SC = J('MERCURY_', 'SCRI', 'BE')
  const IM = J('MERCURY_', 'IMPLEM', 'ENTER')
  const DELETED_FLAGS = [
    `${SC}(?![_A-Z0-9])`,
    `${SC}_BUS(?![_A-Z0-9])`,
    `${SC}_BUS_LIVE`,
    `${SC}_DAEMON_PERSIST`,
    `${SC}_OWNER_PID`,
    `${SC}_HOOKS`,
    `${SC}_MODEL`,
    `${SC}_TELEMETRY_MS`,
    `${SC}_TOKEN_CEILING`,
    `${SC}_WORKFLOWS`,
    `${SC}_AUTOCLEAR`,
    `${SC}_BACKPRESSURE`,
    `${SC}_CHATROOM`,
    `${SC}_GLOW`,
    `${SC}_IMPLEMENTER`,
    `${SC}_MODE(?![_A-Z0-9])`,
    `${SC}_SCOPE`,
    `${SC}_TASK_ROUTER`,
    `${IM}(?![_A-Z0-9])`,
    `${IM}_EFFORT`,
    `${IM}_MODEL`,
    `${IM}_WORKFLOWS`,
    `${IM}_IDLE_MS`,
    `${IM}_MAX_TURN_MS`,
    J('MERCURY_PARTY_', 'RECON_ALLOW'),
    J('MERCURY_', 'AMANU', 'ENSIS'),
    J('MERCURY_DAEMON_', 'SCRI', 'BE_ENGAGE'),
    J('MERCURY_DAEMON_', 'SCRI', 'BE_WORKFLOWS'),
  ]
  for (const flag of DELETED_FLAGS) {
    const hits = carriers(new RegExp(flag))
    check(`§2 ${flag.replace(/\(\?!.*$/, '')} is spelled nowhere`, hits.length === 0, hits.slice(0, 4).join(', '))
  }
}

// ── §3 the seat roles, the sentinel and the notification key ────────────────
{
  const roles = [J('scri', 'be-router'), J('scri', 'be-implementer')]
  for (const role of roles) {
    const hits = carriers(new RegExp(`['"\`]${role}['"\`]`))
    check(`§3 the seat role '${role}' is spelled nowhere`, hits.length === 0, hits.slice(0, 4).join(', '))
  }
  const sentinel = J('__hermes_', 'scri', 'be_router')
  const sHits = carriers(new RegExp(sentinel))
  check('§3 the router sentinel is spelled nowhere', sHits.length === 0, sHits.slice(0, 4).join(', '))
  const key = J("key: '", 'scri', "be-router'")
  const kHits = carriers(new RegExp(key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  check('§3 the engage-receipt notification key is spelled nowhere', kHits.length === 0, kHits.slice(0, 4).join(', '))
}

// ── §4 the party names and the nameplates ───────────────────────────────────
{
  const names = [
    J('PARTY_', 'TEAM_NAME'),
    J('PARTY_', 'ROUTER_AGENT_NAME'),
    J('PARTY_', 'EXECUTOR_DEFAULT'),
    J('PARTY_', 'VERB_GLYPHS'),
    J('Mercury-', 'Amanu', 'ensis'),
    J('Mercury-', 'Implem', 'ent'),
    J('create', 'PartyEvent', 'Message'),
    J('party_', 'event'),
  ]
  for (const name of names) {
    const hits = carriers(new RegExp(name))
    check(`§4 ${name} is spelled nowhere`, hits.length === 0, hits.slice(0, 4).join(', '))
  }
}

// ── §5 the retired command doors ────────────────────────────────────────────
{
  const registry = readFileSync(join(ROOT, 'src/commands.ts'), 'utf8')
  for (const door of ['all', 'batch', 'chat', J('scri', 'be-promote')]) {
    check(`§5 /${door} is not imported by the command registry`, !registry.includes(J("./commands/", door, "/index.js")))
  }
  const domains = readFileSync(join(ROOT, 'src/components/HelpV2/commandDomains.ts'), 'utf8')
  for (const door of ['all', 'batch', 'chat', 'party', J('scri', 'be-promote')]) {
    check(`§5 the /help domains list no '${door}'`, !new RegExp(`'${door}'`).test(domains))
  }
  const pages = CENSUS.filter(([rel]) => rel === 'README.md' || rel.startsWith('docs/'))
  for (const door of [J('scri', 'be-promote'), 'chat', 'batch']) {
    const re = new RegExp(`\`/${door}\``)
    const hits = pages.filter(([, text]) => re.test(text)).map(([rel]) => rel)
    check(`§5 no doc page advertises /${door}`, hits.length === 0, hits.join(', '))
  }
  const perms = readFileSync(join(ROOT, 'src/types/permissions.ts'), 'utf8')
  check('§5 the permission-mode roster carries no retired mode member', !new RegExp(J("'scri", "be'")).test(perms))
}

// ── §6 the kept mechanisms — deliberate survivors, pinned PRESENT ───────────
{
  const registry = readFileSync(join(ROOT, 'src/substrate/flagRegistry.ts'), 'utf8')
  const survivors: Array<[string, string]> = [
    ['MERCURY_DAEMON_BUS', 'src/utils/swarm/busEnvelopes.ts'],
    ['MERCURY_DAEMON_PERSIST', 'src/daemon/ownedDaemon.ts'],
    ['MERCURY_DAEMON_OWNER_PID', 'src/daemon/ownerWatch.ts'],
    ['MERCURY_WORKER_IDLE_MS', 'src/daemon/roster.ts'],
    ['MERCURY_WORKER_MAX_TURN_MS', 'src/utils/cockpit/daemonSupervisorRows.ts'],
    ['MERCURY_WORKER_RECON_ALLOW', 'src/daemon/workerRecon.ts'],
    ['MERCURY_CARRY_FORWARD', 'src/daemon/carryForward.ts'],
  ]
  for (const [env, consumer] of survivors) {
    const row = new RegExp(`env: '${env}'`).test(registry)
    const read = exists(consumer) && readFileSync(join(ROOT, consumer), 'utf8').includes(env)
    check(`§6 ${env} stays (renamed from the retired mode's spelling): registered, read by ${consumer}`, row && read)
  }
  const envelopes = readFileSync(join(ROOT, 'src/utils/swarm/busEnvelopes.ts'), 'utf8')
  check(
    '§6 the bus envelope writes the neutral protocol type',
    envelopes.includes("BUS_PROTOCOL_TYPE = 'bus_protocol'"),
  )
  check(
    '§6 …and still reads the retired spelling (persisted envelopes) through ONE legacy constant',
    envelopes.includes(J("LEGACY_BUS_PROTOCOL_TYPE = '", 'scri', "be_protocol'")) &&
      envelopes.includes('parsed.type === LEGACY_BUS_PROTOCOL_TYPE') &&
      (envelopes.match(new RegExp(J("'scri", "be_protocol'"), 'g')) ?? []).length === 1,
  )
  const identity = readFileSync(join(ROOT, 'src/services/crew/identity.ts'), 'utf8')
  check(
    '§6 the crew identity keeps the recognition rows so old records still read (nothing mints them)',
    identity.includes(J("'scri", "be'")) && identity.includes(J("'implem", "enter'")),
  )
  const seats = readFileSync(join(ROOT, 'src/utils/model/seatSlots.ts'), 'utf8')
  check(
    '§6 the seat validators stay (the families and the effort tokens) — nothing resolves a seat',
    seats.includes('export function validateSeatModel') &&
      seats.includes('export function validateSeatEffort') &&
      !seats.includes(J('resolve', 'Scri', 'beSeat')) &&
      !seats.includes(J('setOperator', 'SeatSlot')),
  )
}

console.log(failures === 0 ? '\n ✅ THE RETIRED COORDINATION MODES STAY RETIRED' : `\n ❌ ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
