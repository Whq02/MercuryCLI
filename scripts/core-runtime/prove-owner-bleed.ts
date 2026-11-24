#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

process.env.NODE_ENV = 'test'
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'owner-bleed-')))
process.env.MERCURY_CONFIG_DIR = join(scratch, 'config-home')
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })

import { execFileSync } from 'node:child_process'
import { getIsGit } from '../../src/platform/git/git.js'
import { getCrewmateModel } from '../../src/models/catalogue/agentModel.js'
import { sessionEnvNoticeForResult, scrubbedSessionEnvNotice } from '../../src/tools/kit/sessionEnvNotice.js'
import * as state from '../../src/boot/process-state/processState.js'
import { consumeInvokingRequestId, getCrewmateContext, runWithCrewmateContext, type CrewmateContext } from '../../src/crew/agents/agentContext.js'
import { getProjectPathForConfig } from '../../src/platform/config/projectConfig.js'
import { getCwd, getStartingCwd, runWithCwdOverride, setContextShellCwd } from '../../src/platform/files/cwd.js'
import { getAuthConfigHomeDir, withAuthScope } from '../../src/platform/environment/envUtils.js'
import { makeOwnerKey, type OwnerKey } from '../../src/engine/run-owner/ownerKey.js'
import { disposeOwner, registerOwnerScopedStore } from '../../src/engine/run-owner/ownerLifecycle.js'
import { OwnerScopedStore } from '../../src/engine/run-owner/ownerScopedStore.js'
import { ownerFromToolUseContext } from '../../src/engine/run-owner/resolveOwner.js'
import { exec as execShell, getShellCwd, setCwd } from '../../src/platform/shell/shellExec.js'
import { getWorkload, runWithWorkload, WORKLOAD_ADVISOR, WORKLOAD_CRON } from '../../src/models/roads/workloadContext.js'
import { getSystemContext, getUserContext } from '../../src/engine/requestContext.js'
import { projectOnboardingHint, shouldShowProjectOnboarding } from '../../src/boot/projectOnboarding.js'
import type { SessionId } from '../../src/sessions/transcripts/ids.js'
import { cacheImagePath, getStoredImagePath, storedImageState } from '../../src/platform/images/imageStore.js'
import { getSessionEnvironmentScript, invalidateSessionEnvCache } from '../../src/platform/environment/sessionEnvironment.js'

type Expectation = 'own' | 'shared-intended'
type Outcome = 'own' | 'bleed' | 'shared-intended'
type ProbeResult = { id: string; expect: Expectation; outcome: Outcome; detail: string }
type Gate = { wait: () => Promise<void>; open: () => void }
type Wrap = <T>(fn: () => Promise<T>) => Promise<T>

function gate(): Gate {
  let open!: () => void
  const promise = new Promise<void>(r => { open = r })
  return { wait: () => promise, open }
}

function makeDir(name: string): string {
  const dir = join(scratch, name)
  mkdirSync(dir, { recursive: true })
  return realpathSync(dir)
}

const dirA = makeDir('workspace-a')
const subA = makeDir('workspace-a/sub-a')
const dirB = makeDir('workspace-b')
const subB = makeDir('workspace-b/sub-b')
const homeA = makeDir('home-a')
const homeB = makeDir('home-b')

const mkAgent = (id: string, req: string, kind: 'spawn' | 'resume'): CrewmateContext => ({
  agentType: 'subagent',
  agentId: id,
  subagentName: id,
  invokingRequestId: req,
  invocationKind: kind,
})

const usage = (tokens: number, cost: number): state.ModelUsage => ({
  inputTokens: tokens,
  outputTokens: tokens,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
  webSearchRequests: 0,
  costUSD: cost,
})

const asAgent = (ctx: CrewmateContext): Wrap => fn => runWithCrewmateContext({ ...ctx }, fn)
const asCwd = (dir: string): Wrap => fn => runWithCwdOverride(dir, fn)
const asHome = (dir: string): Wrap => fn => withAuthScope(dir, fn)
const asWorkload = (tag: string | undefined): Wrap => fn => runWithWorkload(tag, fn)
const plain: Wrap = fn => fn()

async function abRead<A, B>(opts: {
  wrapA: Wrap
  wrapB: Wrap
  writeA?: () => void | Promise<void>
  writeB?: () => void | Promise<void>
  readA: () => A | Promise<A>
  readB: () => B | Promise<B>
}): Promise<[A, B]> {
  const aWrote = gate()
  const bWrote = gate()
  const aRead = gate()
  return Promise.all([
    opts.wrapA(async () => {
      await opts.writeA?.()
      aWrote.open()
      await bWrote.wait()
      const res = await opts.readA()
      aRead.open()
      return res
    }),
    opts.wrapB(async () => {
      await aWrote.wait()
      await opts.writeB?.()
      bWrote.open()
      await aRead.wait()
      return opts.readB()
    }),
  ])
}

function ownProbe(id: string, ok: boolean, detail: string): ProbeResult {
  return { id, expect: 'own', outcome: ok ? 'own' : 'bleed', detail }
}

function sharedProbe(id: string, shared: boolean, detail: string): ProbeResult {
  return { id, expect: 'shared-intended', outcome: shared ? 'shared-intended' : 'own', detail }
}

const agentA = mkAgent('agent-alpha', 'req-alpha', 'spawn')
const agentB = mkAgent('agent-beta', 'req-beta', 'resume')

const PROBES: Array<() => Promise<ProbeResult>> = [
  async () => {
    const [a, b] = await abRead({
      wrapA: asAgent(agentA),
      wrapB: asAgent(agentB),
      readA: () => ({ id: getCrewmateContext()?.agentId, e1: consumeInvokingRequestId()?.invokingRequestId, e2: consumeInvokingRequestId()?.invokingRequestId }),
      readB: () => ({ id: getCrewmateContext()?.agentId, e1: consumeInvokingRequestId()?.invokingRequestId, e2: consumeInvokingRequestId()?.invokingRequestId }),
    })
    return ownProbe('agent-context', a.id === 'agent-alpha' && a.e1 === 'req-alpha' && a.e2 === undefined && b.id === 'agent-beta' && b.e1 === 'req-beta' && b.e2 === undefined, `A=${a.id}/${a.e1} B=${b.id}/${b.e1}`)
  },
  async () => {
    const [a, b] = await abRead({
      wrapA: asCwd(dirA),
      wrapB: asCwd(dirB),
      readA: () => ({ cwd: getCwd(), start: getStartingCwd() }),
      readB: () => ({ cwd: getCwd(), start: getStartingCwd() }),
    })
    return ownProbe('cwd-override', a.cwd === dirA && a.start === dirA && b.cwd === dirB && b.start === dirB, `A=${a.cwd} B=${b.cwd}`)
  },
  async () => {
    const [a, b] = await abRead({
      wrapA: asCwd(dirA),
      wrapB: asCwd(dirB),
      writeA: () => { setContextShellCwd(subA) },
      writeB: () => { setContextShellCwd(subB) },
      readA: () => getShellCwd(),
      readB: () => getShellCwd(),
    })
    return ownProbe('shell-cwd-scoped', a === subA && b === subB, `A=${a} B=${b}`)
  },
  async () => {
    const [a, b] = await abRead({
      wrapA: asHome(homeA),
      wrapB: asHome(homeB),
      readA: () => getAuthConfigHomeDir(),
      readB: () => getAuthConfigHomeDir(),
    })
    return ownProbe('auth-home-scoped', a === homeA && b === homeB, `A=${a} B=${b}`)
  },
  async () => {
    const [a, b] = await abRead({
      wrapA: asWorkload(WORKLOAD_CRON),
      wrapB: asWorkload(WORKLOAD_ADVISOR),
      readA: () => ({ outer: getWorkload(), cleared: runWithWorkload(undefined, () => getWorkload()), restored: getWorkload() }),
      readB: () => getWorkload(),
    })
    return ownProbe('workload-tag', a.outer === WORKLOAD_CRON && a.cleared === undefined && a.restored === WORKLOAD_CRON && b === WORKLOAD_ADVISOR, `A=${a.outer}/${String(a.cleared)}/${a.restored} B=${b}`)
  },
  async () => {
    const store = new OwnerScopedStore<{ tag: string }>({ name: 'prove-owner-bleed-store', create: () => ({ tag: 'init' }) })
    registerOwnerScopedStore(store)
    const ownerA: OwnerKey = makeOwnerKey({ workspace: dirA, sessionId: 'sess-a', lane: 'agent:alpha' })
    const ownerB: OwnerKey = makeOwnerKey({ workspace: dirB, sessionId: 'sess-b', lane: 'agent:beta' })
    try {
      const [a, b] = await abRead({
        wrapA: plain,
        wrapB: plain,
        writeA: () => { store.get(ownerA).tag = 'alpha' },
        writeB: () => { store.get(ownerB).tag = 'beta' },
        readA: () => store.get(ownerA).tag,
        readB: () => store.get(ownerB).tag,
      })
      await disposeOwner(ownerA)
      const aGone = !store.has(ownerA)
      const bKept = store.peek(ownerB)?.tag === 'beta'
      await disposeOwner(ownerB)
      return ownProbe('owner-scoped-store', a === 'alpha' && b === 'beta' && aGone && bKept, `A=${a} B=${b} aGone=${aGone} bKept=${bKept}`)
    } finally {
      store.clearAllForShutdown()
    }
  },
  async () => {
    const [a, b] = await abRead({
      wrapA: plain,
      wrapB: plain,
      readA: () => ownerFromToolUseContext({ agentId: 'alpha' }),
      readB: () => ownerFromToolUseContext({ agentId: 'beta' }),
    })
    return ownProbe('owner-from-tool-context', a !== b && a.includes('agent%3Aalpha') && b.includes('agent%3Abeta'), `distinct=${a !== b}`)
  },
  async () => {
    state.resetStateForTests()
    const readTotals = () => ({
      cost: Number(state.getTotalCostUSD().toFixed(4)),
      lines: state.getTotalLinesAdded(),
      models: Object.keys(state.getModelUsage()).sort().join(','),
      workloads: Object.keys(state.getWorkloadUsage()).sort().join(','),
    })
    const [a, b] = await abRead({
      wrapA: asAgent(agentA),
      wrapB: asAgent(agentB),
      writeA: () => {
        state.addToTotalCostState(0.1, usage(100, 0.1), 'model-alpha')
        state.addToTotalLinesChanged(10, 2)
        state.addToWorkloadUsageState(WORKLOAD_CRON, usage(10, 0.01), 'model-alpha')
      },
      writeB: () => {
        state.addToTotalCostState(0.25, usage(200, 0.25), 'model-beta')
        state.addToTotalLinesChanged(5, 1)
        state.addToWorkloadUsageState(WORKLOAD_ADVISOR, usage(20, 0.02), 'model-beta')
      },
      readA: readTotals,
      readB: readTotals,
    })
    const shared = a.cost === 0.35 && b.cost === 0.35 && a.lines === 15 && b.lines === 15 && a.models === 'model-alpha,model-beta' && b.models === 'model-alpha,model-beta' && a.workloads === 'advisor,cron' && b.workloads === 'advisor,cron'
    return sharedProbe('session-totals-cost', shared, `A=${a.cost}/${a.lines}/${a.models} B=${b.cost}/${b.lines}/${b.models}`)
  },
  async () => {
    const bootKey = getProjectPathForConfig()
    const [a, b] = await abRead({
      wrapA: asCwd(dirA),
      wrapB: asCwd(dirB),
      readA: () => getProjectPathForConfig(),
      readB: () => getProjectPathForConfig(),
    })
    return sharedProbe('project-config-boot-key', a === bootKey && b === bootKey, `boot=${bootKey} A=${a} B=${b}`)
  },
  async () => {
    state.resetStateForTests()
    state.setOriginalCwd(dirA)
    state.setCwdState(dirA)
    const ac = new AbortController()
    const [a, b] = await abRead({
      wrapA: asAgent(agentA),
      wrapB: asAgent(agentB),
      writeA: async () => { await (await execShell(`cd ${JSON.stringify(subA)}`, ac.signal, 'bash')).result },
      writeB: async () => { await (await execShell(`cd ${JSON.stringify(subB)}`, ac.signal, 'bash')).result },
      readA: () => getShellCwd(),
      readB: () => getShellCwd(),
    })
    return ownProbe('shell-cwd-unscoped-agent', a === subA && b === subB, `A=${a} B=${b}`)
  },
  async () => {
    const scoped = (ctx: CrewmateContext, dir: string, home: string): Wrap => fn =>
      asAgent(ctx)(() => asCwd(dir)(() => asHome(home)(fn)))
    const read = (model: string) => [getCrewmateContext()?.agentId, getCwd(), getAuthConfigHomeDir(), getCrewmateModel('inherit', model)].join('|')
    const [a, b] = await abRead({
      wrapA: scoped(agentA, dirA, homeA), wrapB: scoped(agentB, dirB, homeB),
      readA: () => read('fixture-first'), readB: () => read('fixture-second'),
    })
    return ownProbe('nested-owner-fields', a === [agentA.agentId, dirA, homeA, 'fixture-first'].join('|') && b === [agentB.agentId, dirB, homeB, 'fixture-second'].join('|'), `A=${a} B=${b}`)
  },
  async () => {
    execFileSync('git', ['init', '--quiet', dirA])
    const [a, b] = await abRead({ wrapA: asCwd(dirA), wrapB: asCwd(dirB), writeA: async () => { await getIsGit() }, readA: getIsGit, readB: getIsGit })
    return ownProbe('repository-kind', a && !b, `A=${a} B=${b}`)
  },
  async () => {
    const args = { scrubbed: ['EXAMPLE_MARKER'], commandText: '' }
    const expected = scrubbedSessionEnvNotice(args.scrubbed)
    const [a, b] = await abRead({ wrapA: asAgent(agentA), wrapB: asAgent(agentB), readA: () => sessionEnvNoticeForResult(args), readB: () => sessionEnvNoticeForResult(args) })
    return ownProbe('first-conversation-notice', a === expected && b === expected, `A=${a === expected} B=${b === expected}`)
  },
  async () => {
    const prev = state.getSessionId()
    const item = { id: 1, type: 'image' as const, content: '', mediaType: 'image/png' }
    try {
      state.switchSession('bleed-img-a' as SessionId)
      const pathA = cacheImagePath(item)
      const aInitial = getStoredImagePath(1)
      state.switchSession('bleed-img-b' as SessionId)
      const bBefore = getStoredImagePath(1)
      const pathB = cacheImagePath(item)
      const bOwn = getStoredImagePath(1)
      state.switchSession('bleed-img-a' as SessionId)
      const aAfter = getStoredImagePath(1)
      const aState = storedImageState(1)?.path ?? null
      const ok = pathA !== null && pathB !== null && pathA !== pathB && aInitial === pathA && bBefore === null && bOwn === pathB && aAfter === pathA && aState === pathA
      return ownProbe('image-path-cache', ok, `bBeforeNull=${bBefore === null} aKept=${aAfter === pathA} distinct=${pathA !== pathB}`)
    } finally {
      state.switchSession(prev)
    }
  },
  async () => {
    const prev = state.getSessionId()
    const prevEnvFile = process.env.MERCURY_ENV_FILE
    delete process.env.MERCURY_ENV_FILE
    const envDirA = join(process.env.MERCURY_CONFIG_DIR!, 'session-env', 'bleed-env-a')
    mkdirSync(envDirA, { recursive: true })
    writeFileSync(join(envDirA, 'session-start-hook-0.sh'), '# marker-env-a\n')
    try {
      invalidateSessionEnvCache()
      state.switchSession('bleed-env-a' as SessionId)
      const aFirst = await getSessionEnvironmentScript(true)
      state.switchSession('bleed-env-b' as SessionId)
      const bAbsent = await getSessionEnvironmentScript(true)
      state.switchSession('bleed-env-a' as SessionId)
      const aReturn = await getSessionEnvironmentScript(true)
      const ok = aFirst?.trim() === '# marker-env-a' && bAbsent === null && aReturn?.trim() === '# marker-env-a'
      return ownProbe('session-env-cache', ok, `A=${aFirst?.trim() ?? 'null'} B=${bAbsent?.trim() ?? 'null'} A2=${aReturn?.trim() ?? 'null'}`)
    } finally {
      if (prevEnvFile === undefined) delete process.env.MERCURY_ENV_FILE
      else process.env.MERCURY_ENV_FILE = prevEnvFile
      state.switchSession(prev)
      invalidateSessionEnvCache()
    }
  },
  async () => {
    const ctxGit = makeDir('ctx-git')
    const ctxPlain = makeDir('ctx-plain')
    execFileSync('git', ['init', '--quiet', ctxGit])
    getUserContext.cache.clear?.()
    getSystemContext.cache.clear?.()
    try {
      const [a, b] = await abRead({
        wrapA: asCwd(ctxGit),
        wrapB: asCwd(ctxPlain),
        writeA: async () => { await getUserContext(); await getSystemContext() },
        readA: async () => ({ user: await getUserContext(), sys: await getSystemContext() }),
        readB: async () => ({ user: await getUserContext(), sys: await getSystemContext() }),
      })
      const ok = a.user.environment === 'Is a git repository: Yes' && b.user.environment === 'Is a git repository: No' && a.user !== b.user && a.sys !== b.sys
      return ownProbe('context-folder-memo', ok, `A=${a.user.environment} B=${b.user.environment} sameSys=${a.sys === b.sys}`)
    } finally {
      getUserContext.cache.clear?.()
      getSystemContext.cache.clear?.()
    }
  },
  async () => {
    const onbEmpty = makeDir('onb-empty')
    const onbGuided = makeDir('onb-guided')
    writeFileSync(join(onbGuided, 'MERCURY.md'), '# fixture\n')
    shouldShowProjectOnboarding.cache.clear?.()
    projectOnboardingHint.cache.clear?.()
    try {
      const [a, b] = await abRead({
        wrapA: asCwd(onbEmpty),
        wrapB: asCwd(onbGuided),
        writeA: () => { shouldShowProjectOnboarding(); projectOnboardingHint() },
        readA: () => ({ show: shouldShowProjectOnboarding(), hint: projectOnboardingHint() }),
        readB: () => ({ show: shouldShowProjectOnboarding(), hint: projectOnboardingHint() }),
      })
      const ok = a.show === true && typeof a.hint === 'string' && a.hint.includes('fresh app') && b.show === false && b.hint === undefined
      return ownProbe('onboarding-folder-memo', ok, `A=${a.show}/${a.hint ? 'text' : 'none'} B=${b.show}/${b.hint ? 'text' : 'none'}`)
    } finally {
      shouldShowProjectOnboarding.cache.clear?.()
      projectOnboardingHint.cache.clear?.()
    }
  },
]

const tablePath = join(dirname(fileURLToPath(import.meta.url)), 'owner-bleed.tsv')

function readBleedTable(): Set<string> {
  const lines = readFileSync(tablePath, 'utf8').split(/\r?\n/).map(l => l.trim()).filter(Boolean)
  return new Set(lines.slice(1).map(l => l.split('\t')[0]!).filter(Boolean))
}

async function main(): Promise<void> {
  const results: ProbeResult[] = []
  try {
    for (const run of PROBES) results.push(await run())
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }

  const stored = readBleedTable()
  const observed = new Set<string>()
  let failures = 0
  let ownCount = 0
  let sharedCount = 0

  console.log('id\texpect\toutcome\tdetail')
  for (const r of results) {
    console.log(`${r.id}\t${r.expect}\t${r.outcome}\t${r.detail}`)
    if (r.expect === 'shared-intended') {
      if (r.outcome === 'shared-intended') sharedCount++
      else {
        failures++
        console.log(`  [FAIL] ${r.id}: intended share broke (${r.outcome}) — ${r.detail}`)
      }
      continue
    }
    if (r.outcome === 'own') {
      ownCount++
      if (stored.has(r.id)) {
        failures++
        console.log(`  [FAIL] ${r.id}: now own — remove ${r.id} from scripts/core-runtime/owner-bleed.tsv`)
      }
    } else {
      observed.add(r.id)
      if (!stored.has(r.id)) {
        failures++
        console.log(`  [FAIL] ${r.id}: unrecorded bleed — ${r.detail}`)
      }
    }
  }
  for (const id of stored) {
    if (!observed.has(id) && !results.some(r => r.id === id)) {
      failures++
      console.log(`  [FAIL] ${id}: stale row in scripts/core-runtime/owner-bleed.tsv has no probe`)
    }
  }

  console.log(`\nsummary: total=${results.length} own=${ownCount} shared-intended=${sharedCount} bleed=${observed.size} table=${stored.size} failures=${failures}`)
  console.log(failures === 0 ? 'prove-owner-bleed: PASS' : `prove-owner-bleed: ${failures} FAILURE(S)`)
  process.exit(failures === 0 ? 0 : 1)
}

await main()
