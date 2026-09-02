#!/usr/bin/env bun
// ============================================================================
//  scripts/editor-bridge/prove-acp-server.ts — PROOF: the ACP server
//  (`mercury acp --stdio`), driven end-to-end over the BUILT dist with the
//  deterministic fixture API (no paid calls):
//
//    (1) initialize — protocol v1, loadSession capability, no auth demands.
//    (2) session/new — 1:1 onto a REAL Mercury session (stream-json child).
//    (3) session/prompt — agent_message_chunk carries the fixture text;
//        stopReason end_turn.
//    (4) the tool + permission loop — a fixture tool_use turn surfaces as
//        session/request_permission (the can_use_tool adapter), the
//        client's allow lands, tool_call/tool_call_update stream, the turn
//        settles on the follow-up text.
//    (5) session/list includes the created session.
//    (6) cancel — session/cancel interrupts a hanging turn; stopReason
//        'cancelled'.
//    (7) close reaps ONLY its own child (a sibling session's child
//        survives).
//    (8) reconnect never replays — a NEW server + session/load answers
//        without any additional model request; the next prompt works.
//    (9) no orphans — after the server exits, no child processes remain.
//
//  Requires a CURRENT dist/mercury.mjs (the pooled gate prebuilds Phase 0;
//  run `bun run build.ts` first when invoking solo).
//
//  Run:  ~/.bun/bin/bun run scripts/editor-bridge/prove-acp-server.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  currentPhase = t // the deadline reporter names the leg that parked
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

// ── deadline discipline (LANE ACP) ─────────────────────────────────────────
// A hang must FAIL the suite loudly, never park it (the pool ran
// leg 3 for 923s before the pool killed it — a parked await names nothing).
// Every ACP request rides a REF'D per-request deadline; the suite itself
// carries a ref'd wall-clock alarm for parks outside any awaited request.
const REQUEST_DEADLINE_MS = 60_000
const SUITE_DEADLINE_MS = 420_000
let currentPhase = '(startup)'
function failHard(why: string): never {
  console.error(`\n✗ DEADLINE: ${why}`)
  console.error(`  phase: ${currentPhase}`)
  try {
    console.error(`  fixture /v1/messages requests so far: ${api.messageRequests().length}`)
  } catch {
    /* the fixture had not started yet */
  }
  process.exit(1)
}
function deadline<T>(label: string, work: Promise<T>, ms = REQUEST_DEADLINE_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => failHard(`'${label}' did not settle within ${ms}ms — the hang class this suite exists to catch`),
      ms,
    ) // deliberately REF'D: the alarm must hold the loop open to fire
    work.then(
      value => {
        clearTimeout(timer)
        resolve(value)
      },
      error => {
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      },
    )
  })
}
/** Wrap a connection's agent context so EVERY request carries the deadline —
 *  one seam, every present and future leg inherits it. */
function withRequestDeadlines<A extends { request: (...a: never[]) => unknown }>(agent: A): A {
  return new Proxy(agent, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver)
      if (prop === 'request' && typeof value === 'function') {
        return (...args: unknown[]) =>
          deadline(
            `${currentPhase} · request ${String(args[0])}`,
            (value as (...a: unknown[]) => Promise<unknown>).apply(target, args),
          )
      }
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value
    },
  })
}
const suiteAlarm = setTimeout(
  () => failHard(`the suite exceeded ${SUITE_DEADLINE_MS}ms wall clock`),
  SUITE_DEADLINE_MS,
) // ref'd on purpose — see above

const DIST = join(process.cwd(), 'dist', 'mercury.mjs')
if (!existsSync(DIST)) {
  console.error('✗ dist/mercury.mjs missing — run `bun run build.ts` first')
  process.exit(1)
}

const configHome = mkdtempSync(join(tmpdir(), 'mosaic-acp-config-'))
const projDir = mkdtempSync(join(tmpdir(), 'mosaic-acp-proj-'))
const daemonDir = mkdtempSync(join(tmpdir(), 'mosaic-acp-daemon-'))
// The prover PROCESS also pins its home to the scratch: the 5e parity leg
// saves a run sidecar from THIS side, and a prover-side write must never
// resolve into the operator's real home (proof hygiene).
process.env.MERCURY_CONFIG_DIR = configHome
const servers: ChildProcess[] = []
process.on('exit', () => {
  for (const s of servers) {
    try {
      s.kill('SIGKILL')
    } catch {
      /* gone */
    }
  }
  for (const dir of [configHome, projDir, daemonDir]) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
  }
})

const { seedFirstRun } = await import('../lib/firstRunSeed.ts')
seedFirstRun(configHome, [projDir])

const { startFixtureApi } = await import('../lib/fixtureApi.ts')
const api = await startFixtureApi([
  { kind: 'text', text: 'fixture says hi' },
  {
    kind: 'tool_use',
    name: 'Write',
    input: { file_path: join(projDir, 'acp-tool-leg.txt'), content: 'written by the tool leg\n' },
    preText: 'running the tool',
  },
  { kind: 'text', text: 'tool leg settled' },
  // §4b: a REAL TaskCreate turn — its settlement must cross
  // as an ACP `plan` session update read from the task owner's store.
  {
    kind: 'tool_use',
    name: 'TaskCreate',
    input: { subject: 'acp plan leg', description: 'the plan crossing' },
    preText: 'planning the work',
  },
  { kind: 'text', text: 'task planned' },
  // Session 2 (sibling) + the reconnect prompt (the cancel leg runs on its
  // OWN server+fixture below — positional queues cannot survive background
  // auxiliary model calls):
  { kind: 'text', text: 'sibling session says hi' },
  { kind: 'text', text: 'post-reconnect prompt works' },
  // Slack for auxiliary calls (summaries etc.) so a late consumer never
  // hits an empty queue mid-journey.
  { kind: 'text', text: 'aux slack 1' },
  { kind: 'text', text: 'aux slack 2' },
  { kind: 'text', text: 'aux slack 3' },
])

const acp = await import('@agentclientprotocol/sdk')

function spawnServer(): ChildProcess {
  const child = spawn((process.execPath.includes('bun') ? 'node' : process.execPath), [DIST, 'acp', '--stdio'], {
    cwd: projDir,
    stdio: ['pipe', 'pipe', 'inherit'],
    env: {
      ...process.env,
      MERCURY_CONFIG_DIR: configHome,
      ANTHROPIC_API_KEY: 'fixture-key',
      ANTHROPIC_BASE_URL: api.url,
      MERCURY_DAEMON_DIR: daemonDir,
      MERCURY_CACHE_CLOCK: '0',
    },
  })
  servers.push(child)
  return child
}

interface Harness {
  server: ChildProcess
  agentCtx: InstanceType<typeof acp.ClientContext>
  updates: Array<{ sessionId: string; update: Record<string, unknown> }>
  permissionAsks: Array<Record<string, unknown>>
  close: () => void
}

function connectClient(server: ChildProcess): Promise<Harness> {
  return new Promise(resolve => {
    const updates: Harness['updates'] = []
    const permissionAsks: Harness['permissionAsks'] = []
    const app = acp
      .client({ name: 'mosaic-conformance' })
      .onNotification('session/update', ctx => {
        updates.push({
          sessionId: String(ctx.params.sessionId),
          update: ctx.params.update as unknown as Record<string, unknown>,
        })
      })
      .onRequest('session/request_permission', ctx => {
        permissionAsks.push(ctx.params as unknown as Record<string, unknown>)
        return { outcome: { outcome: 'selected' as const, optionId: 'allow' } }
      })
    const stream = acp.ndJsonStream(
      Writable.toWeb(server.stdin!) as WritableStream<Uint8Array>,
      Readable.toWeb(server.stdout!) as ReadableStream<Uint8Array>,
    )
    const conn = app.connect(stream)
    resolve({
      server,
      agentCtx: withRequestDeadlines(conn.agent),
      updates,
      permissionAsks,
      close: () => conn.close(),
    })
  })
}

function textUpdates(h: Harness, sessionId: string): string {
  return h.updates
    .filter(u => u.sessionId === sessionId && u.update.sessionUpdate === 'agent_message_chunk')
    .map(u => (u.update.content as { text?: string } | undefined)?.text ?? '')
    .join('')
}

/** Bounded condition wait: true when `cond` held before the deadline, else
 *  false — the check that follows then fails with the state it saw. */
async function untilTrue(cond: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (cond()) return true
    await new Promise(r => setTimeout(r, 25))
  }
  return cond()
}

function childPids(serverPid: number): number[] {
  try {
    return execFileSync('pgrep', ['-P', String(serverPid)], { encoding: 'utf8' })
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(Number)
  } catch {
    return []
  }
}

const server1 = spawnServer()
const h1 = await connectClient(server1)

section('(1) initialize')
const init = await h1.agentCtx.request('initialize', {
  protocolVersion: acp.PROTOCOL_VERSION,
  clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
})
check('protocol v1 negotiated', init.protocolVersion === acp.PROTOCOL_VERSION, String(init.protocolVersion))
check('loadSession capability advertised', init.agentCapabilities?.loadSession === true)
check('no auth methods demanded', (init.authMethods ?? []).length === 0)

section('(2) session/new — 1:1 Mercury session')
const created = await h1.agentCtx.request('session/new', { cwd: projDir, mcpServers: [] })
const sid1 = created.sessionId
check('session created with a real Mercury session id', typeof sid1 === 'string' && sid1.length >= 8, sid1)
check('modes advertised with the permission ladder', created.modes?.availableModes?.some(m => m.id === 'flow') === true)
// the config-option surface is advertised at session birth.
{
  const opts = (created as unknown as { configOptions?: Array<Record<string, unknown>> }).configOptions
  check(
    'configOptions advertise the permission-mode selector at its default',
    Array.isArray(opts) && opts.some(o => o.id === 'permission-mode' && o.currentValue === 'default'),
    JSON.stringify(opts ?? null).slice(0, 160),
  )
}

const IMAGE_B64 = 'aGVsbG8tbWVyY3VyeS1pbWFnZQ=='

section('(3) prompt → streamed text → end_turn')
{
  const res = await h1.agentCtx.request('session/prompt', {
    sessionId: sid1,
    prompt: [
      { type: 'text', text: 'hello from the conformance client' },
      {
        type: 'resource',
        resource: { uri: 'file:///proj/selection.ts', text: 'const answer = 42', mimeType: 'text/plain' },
      },
      // C2: images are a declared prompt capability now — the block must
      // reach the model request as a real base64 image part.
      { type: 'image', mimeType: 'image/png', data: IMAGE_B64 },
    ],
  })
  check('stopReason end_turn', res.stopReason === 'end_turn', res.stopReason)
  // EQUALITY, not includes: the engine once double-wrote every turn envelope
  // (executeTurn's direct routeOutbound beside the outbound pump), so the
  // chunk text arrived doubled — an includes() check cannot see that.
  check(
    'agent_message_chunk carried the fixture text EXACTLY ONCE',
    textUpdates(h1, sid1) === 'fixture says hi',
    JSON.stringify(textUpdates(h1, sid1)).slice(0, 120),
  )
  // j18: the embedded selection context reached the MODEL request verbatim.
  const firstBody = JSON.stringify(api.messageRequests()[0]?.body ?? {})
  check('embedded resource context reached the model request', firstBody.includes('const answer = 42') && firstBody.includes('attached-resource'))
  check(
    'the image crossed to the model request as base64 (C2 images partial closed)',
    firstBody.includes(IMAGE_B64),
  )
}

// Verify-wave regression (ACP finding 1): a cancel landing AFTER a turn
// settled must not poison the NEXT turn's stopReason — §4's end_turn
// assertion below is the proof.
await h1.agentCtx.notify('session/cancel', { sessionId: sid1 })
await new Promise(r => setTimeout(r, 300))

section('(4) tool + permission loop')
{
  const res = await h1.agentCtx.request('session/prompt', {
    sessionId: sid1,
    prompt: [{ type: 'text', text: 'run the tool' }],
  })
  check('turn settled after the tool leg', res.stopReason === 'end_turn', res.stopReason)
  check('request_permission surfaced the Write ask', h1.permissionAsks.some(a => JSON.stringify(a).includes('Write')))
  check('the allowed tool actually executed', existsSync(join(projDir, 'acp-tool-leg.txt')))
  const toolCalls = h1.updates.filter(u => u.update.sessionUpdate === 'tool_call')
  const toolDone = h1.updates.filter(u => u.update.sessionUpdate === 'tool_call_update')
  check('tool_call streamed', toolCalls.length >= 1)
  check('tool_call_update settled it', toolDone.some(u => u.update.status === 'completed'))
  check('the follow-up text landed', textUpdates(h1, sid1).includes('tool leg settled'))
}

section('(4b) rendezvous C2 — plan · usage updates cross from the child')
{
  const res = await h1.agentCtx.request('session/prompt', {
    sessionId: sid1,
    prompt: [{ type: 'text', text: 'plan the work' }],
  })
  check('the task turn settled', res.stopReason === 'end_turn', res.stopReason)
  // The plan notify chains an async task-store read — observed-ready, never
  // a fixed sleep.
  const planSeen = async (): Promise<Record<string, unknown> | undefined> => {
    for (let i = 0; i < 100; i++) {
      const u = h1.updates.find(x => x.update.sessionUpdate === 'plan')
      if (u) return u.update
      await new Promise(r => setTimeout(r, 50))
    }
    return undefined
  }
  const plan = await planSeen()
  const entries = (plan?.entries ?? []) as Array<Record<string, unknown>>
  check(
    'a plan session update crossed with the task owner\'s row',
    entries.some(e => e.content === 'acp plan leg' && typeof e.status === 'string'),
    JSON.stringify(plan ?? null).slice(0, 200),
  )
  const usage = h1.updates.filter(u => u.update.sessionUpdate === 'usage_update')
  check('usage_update crossed after the turns', usage.length >= 1, String(usage.length))
  const lastUsage = usage[usage.length - 1]?.update as { used?: number; size?: number } | undefined
  check(
    'usage carries real occupancy + a model-owner window',
    (lastUsage?.used ?? 0) > 0 && (lastUsage?.size ?? 0) >= 200_000,
    JSON.stringify(lastUsage ?? null),
  )
}

section('(5) session/list')
{
  const list = await h1.agentCtx.request('session/list', {})
  check('the session is listed', list.sessions.some(s => s.sessionId === sid1))
}

section('(5b) load honesty — a nonexistent session is refused')
{
  let refused = false
  let detail = 'REQUEST SUCCEEDED'
  try {
    await h1.agentCtx.request('session/load', {
      sessionId: '00000000-0000-0000-0000-00000000dead',
      cwd: projDir,
      mcpServers: [],
    })
  } catch (e) {
    // The SDK wraps handler throws as RequestError with the real message in
    // .data.details — match there, not on the generic 'Internal error'.
    const err = e as { data?: { details?: string }; message?: string }
    detail = err.data?.details ?? err.message ?? String(e)
    refused = detail.includes('unknown session')
  }
  check('session/load refuses an id no transcript backs', refused, detail.slice(0, 120))
}

section('(5c) _mercury/artifacts is PROJECT-scoped (same truth as the TUI)')
{
  // The store is home-scoped; the TUI workbench lists project-scoped heads
  // (verify wave, UI finding 3). The bridge read surface declares "same
  // truth as the TUI" — a foreign project's artifact must not leak into
  // this workspace's sidebar.
  process.env.MERCURY_REVIEW_ARTIFACTS_DIR = join(configHome, 'review-artifacts')
  const { createReviewArtifact } = await import('../../src/utils/artifacts/reviewStore.ts')
  const foreignRoot = join(configHome, 'elsewhere-project')
  mkdirSync(foreignRoot, { recursive: true })
  const here = createReviewArtifact({
    kind: 'report',
    title: 'lantern-here',
    producer: { sessionId: 'lantern' },
    workspace: { roots: [projDir] },
    body: { kind: 'report', markdown: '# here' },
    // ready-for-review: the C2 attention-wire leg below reads this exact
    // row crossing as a ready-to-review attention item.
    initialStatus: 'ready-for-review',
  })
  const foreign = createReviewArtifact({
    kind: 'report',
    title: 'lantern-foreign',
    producer: { sessionId: 'lantern' },
    workspace: { roots: [foreignRoot] },
    body: { kind: 'report', markdown: '# foreign' },
  })
  check('seeded both artifacts', here.ok && foreign.ok)
  const res = (await h1.agentCtx.request('_mercury/artifacts', {})) as {
    heads: Array<{ title: string }>
  }
  const titles = res.heads.map(h => h.title)
  check('the workspace artifact is listed', titles.includes('lantern-here'))
  check(
    'a FOREIGN project artifact never leaks into this workspace',
    !titles.includes('lantern-foreign'),
    `heads: ${titles.join(', ')}`,
  )
}

section('(5c2) rendezvous C2 — the attention wire crosses from the request\'s own snapshot')
{
  // The wave-C review's blocker, pinned dead E2E: the wire is the PURE
  // bridge fold over the snapshot this very request resolved — the staged
  // ready-for-review artifact above must cross as a ready-to-review item
  // (the old scoped-arm path folded a null cache and crossed empty-as-fact).
  const wb = (await h1.agentCtx.request('_mercury/workbench', {})) as {
    attention?: {
      version: number
      needsYou: number
      buckets: Partial<Record<string, Array<{ subjectId: string; reasonCode: string }>>>
    }
  }
  check('the workbench answer carries the attention wire', wb.attention !== undefined)
  const review = wb.attention?.buckets['ready-to-review'] ?? []
  check(
    'the staged review artifact crosses as a ready-to-review attention item',
    review.some(i => i.reasonCode === 'review-queued'),
    JSON.stringify(wb.attention ?? null).slice(0, 240),
  )
  check(
    'needsYou is a number the fold computed (never a dormant fabrication)',
    typeof wb.attention?.needsYou === 'number',
  )
}

section('(5d) _mercury/run exposes a coherent run revision to the client')
{
  // SCOPE, stated because the tempting version of this is not sound. The ACP
  // server here is a SEPARATE PROCESS running dist, and processMainOwner()
  // resolves per process — so comparing this prover's runRevision() against
  // the child's would compare two different owners and mean nothing. True
  // cross-process parity needs both surfaces on ONE owner — which 5e below
  // now arranges by NAMING the owner over the wire.
  //
  // What IS verifiable here, and was not before the surface existed: an ACP
  // client can ask which revision of the run it is being told about, and gets
  // a coherent, stable answer instead of no answer at all.
  const res = (await h1.agentCtx.request('_mercury/run', {})) as {
    revision?: number
    run?: { objective?: string } | null
    unavailable?: string
  }
  check(
    'the run surface answers with a numeric revision',
    typeof res.revision === 'number',
    JSON.stringify(res).slice(0, 200),
  )
  check(
    'it reports the run honestly — a snapshot, an explicit null, or a named unavailable',
    res.run !== undefined || typeof res.unavailable === 'string',
    JSON.stringify(res).slice(0, 200),
  )
  const again = (await h1.agentCtx.request('_mercury/run', {})) as { revision?: number }
  check(
    'the revision is stable across reads with no write between them',
    again.revision === res.revision,
    `${String(res.revision)} → ${String(again.revision)}`,
  )
}

section('(5e) TRUE cross-process parity — TUI-side durable writes, the ACP process answers for the SAME named owner')
{
  // THIS process is the "TUI side": it saves the run sidecar through the real
  // writer (allocating revisions in memory as the TUI does). The dist child
  // is the editor bridge: it has NO in-memory run for this owner, so its
  // answer can only come from its own disk load seeding the revision — two
  // code paths, one owner, one number. The sidecar path derives from the
  // reader's config home AND original cwd, so the parity server shares BOTH
  // (scratch home; cwd = this process's cwd), exactly the field arrangement
  // of an editor bridge opened in the project the TUI session lives in.
  const { saveRunSidecar, runRevision } = await import('../../src/services/run/runSidecar.js')
  const { emptyRunSnapshot } = await import('../../src/services/run/runKernel.js')
  const { makeOwnerKey } = await import('../../src/services/run/ownerKey.js')
  const owner = makeOwnerKey({
    workspace: process.cwd(),
    sessionId: `keel-parity-${Date.now().toString(36)}`,
    lane: 'main',
  })
  const snap = emptyRunSnapshot({
    runId: 'run-parity',
    owner,
    objective: 'cross-process parity',
    rootMessageId: null,
    at: Date.now(),
  })
  await saveRunSidecar(owner, snap)
  await saveRunSidecar(owner, snap)
  const local = runRevision(owner)
  check('TUI side made two durable writes (local revision 2)', local === 2, String(local))

  const parityServer = spawn((process.execPath.includes('bun') ? 'node' : process.execPath), [DIST, 'acp', '--stdio'], {
    cwd: process.cwd(),
    stdio: ['pipe', 'pipe', 'inherit'],
    env: {
      ...process.env,
      MERCURY_CONFIG_DIR: configHome,
      ANTHROPIC_API_KEY: 'fixture-key',
      ANTHROPIC_BASE_URL: api.url,
      MERCURY_DAEMON_DIR: daemonDir,
      MERCURY_CACHE_CLOCK: '0',
    },
  })
  servers.push(parityServer)
  const hp = await connectClient(parityServer)
  await hp.agentCtx.request('initialize', {
    protocolVersion: acp.PROTOCOL_VERSION,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
  })

  const res = (await hp.agentCtx.request('_mercury/run', { owner })) as {
    revision?: number
    run?: { objective?: string } | null
  }
  check(
    'the ACP process answers the SAME revision for the SAME owner',
    res.revision === local,
    `local=${local} remote=${String(res.revision)}`,
  )
  check(
    'the run itself crossed (objective matches the TUI-side save)',
    res.run?.objective === 'cross-process parity',
    JSON.stringify(res.run ?? null).slice(0, 120),
  )

  // Another TUI-side durable write; the remote answer must advance with it —
  // the child cannot be echoing a cached number.
  await saveRunSidecar(owner, snap)
  const local3 = runRevision(owner)
  const res2 = (await hp.agentCtx.request('_mercury/run', { owner })) as { revision?: number }
  check(
    'a further durable write advances BOTH surfaces in step',
    local3 === 3 && res2.revision === local3,
    `local=${local3} remote=${String(res2.revision)}`,
  )

  // A malformed owner is refused, never guessed — answering for the wrong
  // owner is the split-brain this surface exists to close.
  const bad = (await hp.agentCtx.request('_mercury/run', { owner: 'not-an-owner-key' })) as {
    error?: string
    revision?: number
  }
  check(
    'a malformed owner key is refused, not guessed',
    bad.error === 'malformed owner key' && bad.revision === undefined,
    JSON.stringify(bad).slice(0, 120),
  )

  // The ownerless ask still answers from the process default (5d's surface).
  const def = (await hp.agentCtx.request('_mercury/run', {})) as { revision?: number }
  check('the ownerless ask still answers (default unchanged)', typeof def.revision === 'number')

  parityServer.kill()
}

section('(5f) source-state honesty crosses ACP: ready ≠ unavailable ≠ empty (end to end)')
{
  // The vocabulary and the projection are proven in-process (prove-source-
  // vocabulary, prove-source-truth). This leg is the BOUNDARY: the same three
  // conditions must arrive DISTINCT through a real protocol client talking to
  // a real dist child — an unreadable store crossing as `heads: []` would be
  // the exact confident-false-statement defect H named.
  type ArtifactsRes = { heads?: unknown[]; source?: { state?: string; reason?: string } }
  const reviewDir = join(configHome, 'review-artifacts')

  const ready = (await h1.agentCtx.request('_mercury/artifacts', {})) as ArtifactsRes
  check(
    'an enumerated store crosses as READY with its heads',
    ready.source?.state === 'ready' && (ready.heads ?? []).length >= 1,
    JSON.stringify(ready.source ?? null),
  )

  chmodSync(reviewDir, 0o000)
  const dark = (await h1.agentCtx.request('_mercury/artifacts', {})) as ArtifactsRes
  chmodSync(reviewDir, 0o755)
  check(
    'an UNREADABLE store crosses as UNAVAILABLE with a reason — never as empty',
    dark.source?.state === 'unavailable' && typeof dark.source?.reason === 'string',
    JSON.stringify(dark.source ?? null),
  )

  renameSync(reviewDir, `${reviewDir}.parked`)
  const gone = (await h1.agentCtx.request('_mercury/artifacts', {})) as ArtifactsRes
  renameSync(`${reviewDir}.parked`, reviewDir)
  check(
    'an ABSENT store crosses as EMPTY — a genuine nothing, not a failure',
    gone.source?.state === 'empty',
    JSON.stringify(gone.source ?? null),
  )

  const back = (await h1.agentCtx.request('_mercury/artifacts', {})) as ArtifactsRes
  check(
    'recovery: the restored store answers READY again',
    back.source?.state === 'ready' && (back.heads ?? []).length >= 1,
    JSON.stringify(back.source ?? null),
  )
  check(
    'three DISTINCT source states crossed one real protocol boundary',
    new Set([ready, dark, gone].map(r => r.source?.state)).size === 3,
  )
}

section('(5g) rendezvous C2 — the config-option surface round-trips')
{
  const before = h1.updates.length
  const res = (await h1.agentCtx.request('session/set_config_option', {
    sessionId: sid1,
    configId: 'permission-mode',
    value: 'implement',
  })) as { configOptions?: Array<Record<string, unknown>> }
  check(
    'set_config_option answers the full set with the new value current',
    res.configOptions?.some(o => o.id === 'permission-mode' && o.currentValue === 'implement') === true,
    JSON.stringify(res.configOptions ?? null).slice(0, 160),
  )
  await new Promise(r => setTimeout(r, 200))
  const fresh = h1.updates.slice(before).map(u => u.update)
  check(
    'config_option_update notified',
    fresh.some(
      u =>
        u.sessionUpdate === 'config_option_update' &&
        (u.configOptions as Array<Record<string, unknown>> | undefined)?.some(
          o => o.currentValue === 'implement',
        ),
    ),
  )
  check(
    'current_mode_update notified — one truth, both vocabularies',
    fresh.some(u => u.sessionUpdate === 'current_mode_update' && u.currentModeId === 'implement'),
  )
  let refused = false
  try {
    await h1.agentCtx.request('session/set_config_option', {
      sessionId: sid1,
      configId: 'permission-mode',
      value: 'not-a-mode',
    })
  } catch {
    refused = true
  }
  check('an unknown value is refused, never guessed', refused)
  // Restore the default so later legs see an untouched ladder.
  await h1.agentCtx.request('session/set_config_option', {
    sessionId: sid1,
    configId: 'permission-mode',
    value: 'default',
  })
}

section('(6) cancel interrupts a hanging turn (dedicated server + fixture)')
{
  const hangApi = await startFixtureApi([
    { kind: 'hang', deltas: ['about to hang'] },
    { kind: 'hang', deltas: ['about to hang again'] },
  ])
  const hangServer = spawn((process.execPath.includes('bun') ? 'node' : process.execPath), [DIST, 'acp', '--stdio'], {
    cwd: projDir,
    stdio: ['pipe', 'pipe', 'inherit'],
    env: {
      ...process.env,
      MERCURY_CONFIG_DIR: configHome,
      ANTHROPIC_API_KEY: 'fixture-key',
      ANTHROPIC_BASE_URL: hangApi.url,
      MERCURY_DAEMON_DIR: daemonDir,
      MERCURY_CACHE_CLOCK: '0',
    },
  })
  servers.push(hangServer)
  const hh = await connectClient(hangServer)
  await hh.agentCtx.request('initialize', { protocolVersion: acp.PROTOCOL_VERSION })
  const hangSession = await hh.agentCtx.request('session/new', { cwd: projDir, mcpServers: [] })
  const hangRequestsBefore = hangApi.messageRequests().length
  const promptPromise = hh.agentCtx.request('session/prompt', {
    sessionId: hangSession.sessionId,
    prompt: [{ type: 'text', text: 'this will hang' }],
  })
  // The hang turn has reached the fixture (its model request landed) before
  // the cancel goes out — bounded; a turn that never arrives still cancels.
  await untilTrue(() => hangApi.messageRequests().length > hangRequestsBefore, 10_000)
  await hh.agentCtx.notify('session/cancel', { sessionId: hangSession.sessionId })
  const res = await promptPromise
  check('stopReason cancelled', res.stopReason === 'cancelled', res.stopReason)

  // Verify-wave regression (ACP finding 2): session/close during an
  // in-flight prompt must SETTLE the pending request, never wedge the
  // client. A second hang turn is queued on the same dedicated fixture.
  const hang2 = await hangApi // placeholder no-op to keep types simple
  void hang2
  const secondSession = await hh.agentCtx.request('session/new', { cwd: projDir, mcpServers: [] })
  const wedgeRequestsBefore = hangApi.messageRequests().length
  const wedgeCandidate = hh.agentCtx.request('session/prompt', {
    sessionId: secondSession.sessionId,
    prompt: [{ type: 'text', text: 'hang again' }],
  })
  await untilTrue(() => hangApi.messageRequests().length > wedgeRequestsBefore, 10_000)
  await hh.agentCtx.request('session/close', { sessionId: secondSession.sessionId })
  const settled = await Promise.race([
    wedgeCandidate.then(r => r.stopReason),
    new Promise<string>(r => setTimeout(() => r('WEDGED'), 8000)),
  ])
  check('close during an in-flight prompt settles it (never a wedge)', settled === 'cancelled', String(settled))

  hh.close()
  hangServer.kill('SIGTERM')
  await hangApi.close()
}

section('(7) close reaps ONLY its own child')
{
  const created2 = await h1.agentCtx.request('session/new', { cwd: projDir, mcpServers: [] })
  const sid2 = created2.sessionId
  check('sibling session created', typeof sid2 === 'string' && sid2 !== sid1)
  const before = childPids(server1.pid!)
  check('two children live', before.length >= 2, String(before.length))
  await h1.agentCtx.request('session/close', { sessionId: sid1 })
  // the reap is the observable; the check below reads whatever state arrived
  await untilTrue(() => childPids(server1.pid!).length === before.length - 1, 10_000)
  const after = childPids(server1.pid!)
  check('exactly the closed session was reaped', after.length === before.length - 1, `${before.length} → ${after.length}`)
  // Keep sid2 for the reconnect leg's list assertion; use its child liveness.
  const sibling = await h1.agentCtx.request('session/prompt', {
    sessionId: sid2,
    prompt: [{ type: 'text', text: 'sibling still alive?' }],
  })
  check('the sibling session still works', sibling.stopReason === 'end_turn')
}

section('(8) reconnect — session/load never replays')
{
  const requestsBefore = api.messageRequests().length
  h1.close()
  server1.kill('SIGTERM')
  await untilTrue(() => server1.exitCode !== null || server1.signalCode !== null, 10_000)

  const server2 = spawnServer()
  const h2 = await connectClient(server2)
  await h2.agentCtx.request('initialize', { protocolVersion: acp.PROTOCOL_VERSION })
  const load1 = await h2.agentCtx.request('session/load', { sessionId: sid1, cwd: projDir, mcpServers: [] })
  const requestsAfterLoad = api.messageRequests().length
  check('load made ZERO model requests (no replay)', requestsAfterLoad === requestsBefore, `${requestsBefore} → ${requestsAfterLoad}`)
  // loading is IDEMPOTENT — a second load answers the same
  // truth without any model call.
  const load2 = await h2.agentCtx.request('session/load', { sessionId: sid1, cwd: projDir, mcpServers: [] })
  check(
    'a second load is idempotent (same modes + configOptions, zero replays)',
    api.messageRequests().length === requestsAfterLoad &&
      JSON.stringify(load2.modes) === JSON.stringify(load1.modes) &&
      JSON.stringify((load2 as unknown as Record<string, unknown>).configOptions) ===
        JSON.stringify((load1 as unknown as Record<string, unknown>).configOptions),
  )
  const res = await h2.agentCtx.request('session/prompt', {
    sessionId: sid1,
    prompt: [{ type: 'text', text: 'after the reconnect' }],
  })
  check('post-reconnect prompt works', res.stopReason === 'end_turn', res.stopReason)
  check('exactly one new model request for it', api.messageRequests().length === requestsAfterLoad + 1)

  section('(9) no orphans after the server exits')
  const server2Pid = server2.pid!
  h2.close()
  server2.kill('SIGTERM')
  await untilTrue(() => childPids(server2Pid).length === 0 && (server2.exitCode !== null || server2.signalCode !== null), 10_000)
  check('no children survive the server', childPids(server2Pid).length === 0)
  check('the server process itself exited', (() => {
    try {
      process.kill(server2Pid, 0)
      return false
    } catch {
      return true
    }
  })())
}

clearTimeout(suiteAlarm)
await api.close()
console.log('')
if (failures > 0) {
  console.error(`✗ ${failures} failure(s)`)
  process.exit(1)
}
console.log('✓ ACP server conformance green')
