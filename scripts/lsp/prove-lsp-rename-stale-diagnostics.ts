#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { DiagnosticFile } from '../../src/integrations/lsp/diagnosticTracking.js'
import type { ToolUseContext } from '../../src/tools/kit/tool.js'

const repo = path.resolve(import.meta.dir, '../..')
const stubPath = path.join(repo, 'scripts/lsp/fixtures/half-rename-lsp-server.mjs')
const scratch = realpathSync(mkdtempSync(path.join(tmpdir(), 'lsp-rename-stale-diag-')))
const home = path.join(scratch, 'home')
mkdirSync(home, { recursive: true })
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CHANGESET_DIR = path.join(scratch, 'changesets')
delete process.env.MERCURY_HOME
delete process.env.MERCURY_LSP
process.on('exit', () => rmSync(scratch, { recursive: true, force: true }))

const wsRoot = path.join(scratch, 'ws')
const pullDir = path.join(wsRoot, 'pull')
const pushDir = path.join(wsRoot, 'push')
const peerDir = path.join(wsRoot, 'peer')
const dualDir = path.join(wsRoot, 'dual')
for (const dir of [pullDir, pushDir, peerDir, dualDir]) mkdirSync(dir, { recursive: true })
symlinkSync(path.join(repo, 'node_modules'), path.join(wsRoot, 'node_modules'), 'dir')

process.env.MERCURY_LSP_SIDECAR_ENTRY = stubPath
process.env.MERCURY_LSP_SERVERS = JSON.stringify({
  'stub-push': {
    command: process.execPath,
    args: [stubPath],
    extensionToLanguage: { '.zz': 'zed' },
    env: { HALF_RENAME_PULL: '0' },
  },
  'stub-dual': {
    command: process.execPath,
    args: [stubPath],
    extensionToLanguage: { '.dd': 'dual' },
  },
})

process.chdir(wsRoot)

const { enableConfigs } = await import('../../src/platform/settings/config.js')
enableConfigs()
const state = await import('../../src/boot/process-state/processState.js')
state.setIsInteractive(true)
state.setOriginalCwd(wsRoot)

const mgrModule = await import('../../src/integrations/lsp/serverManagerLifecycle.js')
mgrModule.initializeLspServerManager()
await mgrModule.waitForInitialization()
const manager = mgrModule.getLspServerManager()
if (!manager) throw new Error('LSP manager failed to initialize')

const registry = await import('../../src/integrations/lsp/LSPDiagnosticRegistry.js')
const { deliverAfterRevalidation, getLSPDiagnosticAttachments } = await import('../../src/engine/attachments/diagnostics.js')
const { normalizeAttachmentForAPI } = await import('../../src/engine/messages/attachmentText.js')
const { awaitDiagnosticStabilization, runMercuryLspOp } = await import('../../src/tools/lsp/mercuryOps.js')
const { getEmptyToolPermissionContext } = await import('../../src/tools/kit/tool.js')
const { BASH_TOOL_NAME } = await import('../../src/tools/kit/names/bash.js')
const { processOwnerForLane } = await import('../../src/engine/run-owner/resolveOwner.js')
const { LSP_TOOLS } = await import('../../src/tools/lsp/lspTools.js')
const { FileStateCache } = await import('../../src/platform/files/fileStateCache.js')

const renameTool = LSP_TOOLS.find(tool => tool.name === 'LspRename')!

type DiagAttachment = { type: 'diagnostics'; files: DiagnosticFile[]; isNew: boolean }

let failures = 0
let checks = 0
let staleAttachments = 0
let durableFindings = 0
const waitSamples: Array<{ label: string; applyMs: number; attachMs: number }> = []

function check(name: string, ok: boolean, detail = ''): void {
  checks++
  if (ok) console.log(`  [PASS] ${name}`)
  else {
    failures++
    console.error(`  [FAIL] ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function section(title: string): void {
  console.log(`\n${'─'.repeat(76)}\n${title}`)
}

function writeFourFiles(dir: string, ext: string, sym: string): { defs: string; a: string; b: string; c: string } {
  const defs = path.join(dir, `defs.${ext}`)
  const a = path.join(dir, `a.${ext}`)
  const b = path.join(dir, `b.${ext}`)
  const c = path.join(dir, `c.${ext}`)
  writeFileSync(defs, `export const ${sym} = 1\n`)
  writeFileSync(a, `import { ${sym} } from './defs'\nexport const a1 = ${sym} + 1\nexport const a2 = ${sym} + 2\n`)
  writeFileSync(b, `import { ${sym} } from './defs'\nexport const b1 = ${sym} + 1\nexport const b2 = ${sym} + 2\n`)
  writeFileSync(c, `import { ${sym} } from './defs'\nexport const c1 = ${sym} + 1\n`)
  return { defs, a, b, c }
}

function makeContext(agentId?: string, abortController = new AbortController()): ToolUseContext {
  const permission = getEmptyToolPermissionContext()
  const options: Partial<ToolUseContext['options']> = {
    tools: [{ name: BASH_TOOL_NAME } as ToolUseContext['options']['tools'][number]],
    isNonInteractiveSession: false,
  }
  const base: Partial<ToolUseContext> = {
    abortController,
    readFileState: new FileStateCache(64, 25 * 1024 * 1024),
    getAppState: (() => ({ toolPermissionContext: permission })) as ToolUseContext['getAppState'],
    setAppState: () => {},
    updateFileHistoryState: () => {},
    messages: [],
    setResponseLength: () => {},
    options: options as ToolUseContext['options'],
    ...(agentId !== undefined ? { agentId: agentId as ToolUseContext['agentId'] } : {}),
  }
  return base as ToolUseContext
}

function asDiagAttachments(rows: ReadonlyArray<{ type: string }>): DiagAttachment[] {
  return rows.filter((row): row is DiagAttachment => row.type === 'diagnostics')
}

function modelFacingText(rows: DiagAttachment[]): string {
  return rows
    .flatMap(row => normalizeAttachmentForAPI(row))
    .map(item => JSON.stringify(item.message.content))
    .join('\n')
}

function totalDiagCount(rows: DiagAttachment[]): number {
  return rows.reduce((sum, row) => sum + row.files.reduce((n, f) => n + f.diagnostics.length, 0), 0)
}

function totalFileCount(rows: DiagAttachment[]): number {
  return rows.reduce((sum, row) => sum + row.files.length, 0)
}

async function renameOp(
  cwd: string,
  ctx: ToolUseContext,
  filePath: string,
  newName: string,
  opts: { apply?: boolean; plan?: string } = {},
) {
  return runMercuryLspOp({
    input: {
      operation: 'rename',
      filePath,
      line: 1,
      character: 14,
      newName,
      ...(opts.apply !== undefined ? { apply: opts.apply } : {}),
      ...(opts.plan !== undefined ? { plan: opts.plan } : {}),
    },
    absolutePath: filePath,
    cwd,
    manager,
    tool: renameTool,
    context: ctx,
  })
}

async function configureStub(filePath: string, cfg: Record<string, unknown>): Promise<void> {
  await manager.sendRequest(filePath, 'test/configure', cfg)
}

async function syncStub(filePath: string): Promise<void> {
  await manager.sendRequest(filePath, 'test/sync', {})
}

async function stubPulls(filePath: string): Promise<{ pullCount: number; heldPulls: number }> {
  return (await manager.sendRequest<{ pullCount: number; heldPulls: number }>(filePath, 'test/pullCount', {})) ?? { pullCount: -1, heldPulls: -1 }
}

const QUIET_STUB = {
  releaseHalfOnSaveCount: 0,
  releaseHalfOnFirstChange: false,
  versioned: false,
  settledPushOnSaveCount: 0,
  settledPushDelayMs: 0,
  settledSplitDelayMs: 0,
  silentStems: [],
  defectFile: '',
  defectMessage: '',
  holdNextPullForFile: '',
  clearHeld: true,
  clearPersistent: true,
  resetPullCount: true,
}
const PULL_SERVER = 'mercury-ts'
const PUSH_SERVER = 'env:stub-push'
const REAL_DEFECT = "Type 'number' is not assignable to type 'string'."

function stubFinding(message: string, line = 0) {
  return { range: { start: { line, character: 0 }, end: { line, character: 5 } }, severity: 1, source: 'half-rename-stub', code: '2322', message }
}

try {
  section('§1 unversioned half-state delivered BEFORE clean pull/tool result (8 diagnostics in 3 files)')
  {
    registry.resetAllLSPDiagnosticState()
    const files = writeFourFiles(pullDir, 'ts', 'oldAlpha')
    const ctx = makeContext()
    await configureStub(files.defs, {
      releaseHalfOnSaveCount: 4,
      releaseHalfOnFirstChange: false,
      versioned: false,
      settledPushOnSaveCount: 0,
      silentStems: [],
      defectFile: '',
      clearHeld: true,
      clearPersistent: true,
      resetPullCount: true,
    })
    const preview = await renameOp(pullDir, ctx, files.defs, 'newAlpha')
    check('preview returns plan across 4 files without writing', preview.applied === false && typeof preview.plan === 'string' && readFileSync(files.defs, 'utf8').includes('oldAlpha'), preview.result)

    const applyStart = Date.now()
    const applied = await renameOp(pullDir, ctx, files.defs, 'newAlpha', { apply: true, plan: preview.plan })
    const applyMs = Date.now() - applyStart
    const toolPulls = (await stubPulls(files.defs)).pullCount
    const attachStart = Date.now()
    const attachments = asDiagAttachments(await getLSPDiagnosticAttachments(ctx))
    const attachMs = Date.now() - attachStart
    const attachPulls = (await stubPulls(files.defs)).pullCount - toolPulls
    waitSamples.push({ label: 'pull-unversioned-before-return', applyMs, attachMs })

    const diagCount = totalDiagCount(attachments)
    if (diagCount > 0) staleAttachments += attachments.length

    check(
      'apply succeeds across 4 files with primary-file tool check reporting 0 errors',
      applied.applied === true && applied.effect.outcome === 'succeeded' && applied.effect.changedPaths.length === 4 && /Post-apply diagnostics: 0 error\(s\), 0 warning\(s\)/.test(applied.result),
      applied.result,
    )
    check(
      'next model turn receives 0 stale half-rename diagnostics (not 8 in 3 files)',
      attachments.length === 0 && diagCount === 0,
      `got ${diagCount} diagnostics in ${totalFileCount(attachments)} file(s); witness=${modelFacingText(attachments).slice(0, 320)}`,
    )
    check(
      'the tool asks its primary file once, as on the base, and the attachment asks each of the 4 written files once',
      toolPulls === 1 && attachPulls === 4,
      `tool pulls=${toolPulls} (awaitDiagnosticStabilization in src/tools/lsp/mercury-ops/afterWrite.ts must stay one pull of the primary); attachment pulls=${attachPulls} (pullWrittenFiles in src/integrations/lsp/publishedDiagnostics.ts must ask once per file re-armed by rearmAfterMultiFileSync)`,
    )
  }

  section('§2 unversioned half-state delivered AFTER clean pull/tool result and BEFORE next model attachment')
  {
    registry.resetAllLSPDiagnosticState()
    await manager.closeAllFiles()
    const files = writeFourFiles(pullDir, 'ts', 'oldAfter')
    const ctx = makeContext()
    await configureStub(files.defs, {
      releaseHalfOnSaveCount: 0,
      releaseHalfOnFirstChange: false,
      versioned: false,
      settledPushOnSaveCount: 0,
      silentStems: [],
      defectFile: '',
      clearHeld: true,
      clearPersistent: true,
    })
    const preview = await renameOp(pullDir, ctx, files.defs, 'newAfter')
    const applyStart = Date.now()
    const applied = await renameOp(pullDir, ctx, files.defs, 'newAfter', { apply: true, plan: preview.plan })
    const applyMs = Date.now() - applyStart

    await manager.sendRequest(files.defs, 'test/releaseHalfState', { versioned: false })
    await syncStub(files.defs)

    const attachStart = Date.now()
    const attachments = asDiagAttachments(await getLSPDiagnosticAttachments(ctx))
    const attachMs = Date.now() - attachStart
    waitSamples.push({ label: 'pull-unversioned-after-return', applyMs, attachMs })

    const diagCount = totalDiagCount(attachments)
    if (diagCount > 0) staleAttachments += attachments.length

    check(
      'apply succeeds with 0 post-apply errors on primary file',
      applied.applied === true && /Post-apply diagnostics: 0 error\(s\), 0 warning\(s\)/.test(applied.result),
      applied.result,
    )
    check(
      'unversioned half-state arriving AFTER clean tool return is reconciled away before model attachment',
      attachments.length === 0 && diagCount === 0,
      `got ${diagCount} diagnostics in ${totalFileCount(attachments)} file(s); witness=${modelFacingText(attachments).slice(0, 320)}`,
    )
  }

  section('§3 out-of-order late versioned half-rename notification after settled clean state (pull + push-only)')
  {
    registry.resetAllLSPDiagnosticState()
    await manager.closeAllFiles()
    const files = writeFourFiles(pullDir, 'ts', 'oldBeta')
    const ctx = makeContext()
    await configureStub(files.defs, {
      releaseHalfOnSaveCount: 0,
      releaseHalfOnFirstChange: false,
      versioned: true,
      settledPushOnSaveCount: 4,
      settledPushDelayMs: 5,
      settledSplitDelayMs: 0,
      silentStems: [],
      defectFile: '',
      clearHeld: true,
      clearPersistent: true,
    })
    const preview = await renameOp(pullDir, ctx, files.defs, 'newBeta')
    const applyStart = Date.now()
    const applied = await renameOp(pullDir, ctx, files.defs, 'newBeta', { apply: true, plan: preview.plan })
    const applyMs = Date.now() - applyStart

    await manager.sendRequest(files.defs, 'test/releaseHalfState', { versioned: true })
    await syncStub(files.defs)

    const attachStart = Date.now()
    const attachments = asDiagAttachments(await getLSPDiagnosticAttachments(ctx))
    const attachMs = Date.now() - attachStart
    waitSamples.push({ label: 'pull-late-versioned', applyMs, attachMs })

    const diagCount = totalDiagCount(attachments)
    if (diagCount > 0) staleAttachments += attachments.length
    check(
      'pull-capable out-of-order version-1 notifications arriving after version-2 settlement are rejected',
      applied.applied === true && attachments.length === 0 && diagCount === 0,
      `got ${diagCount} diagnostics in ${totalFileCount(attachments)} file(s); witness=${modelFacingText(attachments).slice(0, 320)}`,
    )

    registry.resetAllLSPDiagnosticState()
    await manager.closeAllFiles()
    const pushFiles = writeFourFiles(pushDir, 'zz', 'oldGamma')
    const pushCtx = makeContext()
    await configureStub(pushFiles.defs, {
      releaseHalfOnSaveCount: 0,
      releaseHalfOnFirstChange: true,
      versioned: true,
      settledPushOnSaveCount: 4,
      settledPushDelayMs: 15,
      settledSplitDelayMs: 40,
      silentStems: ['c'],
      defectFile: '',
      clearHeld: true,
      clearPersistent: true,
    })
    const pushPreview = await renameOp(pushDir, pushCtx, pushFiles.defs, 'newGamma')
    const pushApplyStart = Date.now()
    const pushApplied = await renameOp(pushDir, pushCtx, pushFiles.defs, 'newGamma', { apply: true, plan: pushPreview.plan })
    const pushApplyMs = Date.now() - pushApplyStart

    await manager.sendRequest(pushFiles.defs, 'test/releaseHalfState', { versioned: true })
    await syncStub(pushFiles.defs)

    const pushAttachStart = Date.now()
    const pushAttachments = asDiagAttachments(await getLSPDiagnosticAttachments(pushCtx))
    const pushAttachMs = Date.now() - pushAttachStart
    waitSamples.push({ label: 'push-versioned-one-silent', applyMs: pushApplyMs, attachMs: pushAttachMs })

    const pushDiagCount = totalDiagCount(pushAttachments)
    if (pushDiagCount > 0) staleAttachments += pushAttachments.length
    check(
      'push-only with one never-publishing path (c.zz): primary tool check settles honestly, never fabricates a report for c.zz, and rejects late v1',
      pushApplied.applied === true &&
        /Post-apply diagnostics: 0 error\(s\), 0 warning\(s\)/.test(pushApplied.result) &&
        pushAttachments.length === 0 &&
        pushDiagCount === 0 &&
        registry.peekLastPublishedReport('env:stub-push', pushFiles.c) === undefined,
      `result=${pushApplied.result}; diags=${pushDiagCount}; cLast=${JSON.stringify(registry.peekLastPublishedReport('env:stub-push', pushFiles.c))}`,
    )

    const silentCheck = await awaitDiagnosticStabilization(manager, pushFiles.c, { deadlineMs: 120, quietWindowMs: 40 })
    check(
      'awaitDiagnosticStabilization on a never-publishing push-only path returns timed-out (never fabricated fresh/zero)',
      silentCheck.state === 'timed-out',
      JSON.stringify(silentCheck),
    )
  }

  section('§4 controls: surviving real finding arrives once, per-server isolation, clear sticks, unrelated/peer, preview/drift/cancel')
  {
    registry.resetAllLSPDiagnosticState()
    await manager.closeAllFiles()
    const files = writeFourFiles(pullDir, 'ts', 'oldDelta')
    const ctx = makeContext()
    await configureStub(files.defs, {
      releaseHalfOnSaveCount: 4,
      releaseHalfOnFirstChange: false,
      versioned: false,
      settledPushOnSaveCount: 0,
      silentStems: [],
      defectFile: 'b.ts',
      defectMessage: "Type 'number' is not assignable to type 'string'.",
      clearHeld: true,
      clearPersistent: true,
    })

    const preview = await renameOp(pullDir, ctx, files.defs, 'newDelta')
    const applied = await renameOp(pullDir, ctx, files.defs, 'newDelta', { apply: true, plan: preview.plan })
    await manager.sendRequest(files.defs, 'test/releaseHalfState', { versioned: false })
    await syncStub(files.defs)

    const firstDrain = asDiagAttachments(await getLSPDiagnosticAttachments(ctx))
    const firstCount = totalDiagCount(firstDrain)
    durableFindings += firstCount
    const firstText = modelFacingText(firstDrain)
    const pullsAfterFirstDrain = (await stubPulls(files.defs)).pullCount

    check(
      'primary-file tool check stays honest on defs.ts (0 errors on defs.ts)',
      applied.applied === true && /Post-apply diagnostics: 0 error\(s\), 0 warning\(s\)/.test(applied.result),
      applied.result,
    )
    check(
      'surviving real finding in b.ts arrives in <new-diagnostics> without the 8 half-rename errors',
      firstCount === 1 && firstText.includes("Type 'number' is not assignable to type 'string'.") && !firstText.includes('oldDelta'),
      firstText.slice(0, 320),
    )

    await manager.sendRequest(files.defs, 'test/publish', {
      uri: pathToFileURL(files.b).href,
      diagnostics: [{ range: { start: { line: 1, character: 0 }, end: { line: 1, character: 10 } }, severity: 1, source: 'half-rename-stub', code: '2322', message: "Type 'number' is not assignable to type 'string'." }],
      version: 2,
    })
    await syncStub(files.defs)
    const dupDrain = asDiagAttachments(await getLSPDiagnosticAttachments(ctx))
    check('genuine defect is delivered once (duplicate push deduped)', dupDrain.length === 0, modelFacingText(dupDrain))

    await configureStub(files.defs, { defectFile: '' })
    await manager.sendRequest(files.defs, 'test/publish', {
      uri: pathToFileURL(files.b).href,
      diagnostics: [],
      version: 3,
    })
    await syncStub(files.defs)
    const clearDrain = asDiagAttachments(await getLSPDiagnosticAttachments(ctx))
    check('clear sticks (empty publish delivers nothing)', clearDrain.length === 0, modelFacingText(clearDrain))

    await manager.sendRequest(files.defs, 'test/publish', {
      uri: pathToFileURL(files.b).href,
      diagnostics: [{ range: { start: { line: 1, character: 0 }, end: { line: 1, character: 10 } }, severity: 1, source: 'half-rename-stub', code: '2322', message: 'Stale error from v2.' }],
      version: 2,
    })
    await syncStub(files.defs)
    const resurrectDrain = asDiagAttachments(await getLSPDiagnosticAttachments(ctx))
    check('out-of-order older version after clear does not resurrect cleared defect', resurrectDrain.length === 0, modelFacingText(resurrectDrain))

    await manager.sendRequest(files.defs, 'test/publish', { uri: pathToFileURL(files.a).href, diagnostics: [stubFinding('Late report with no write behind it.')] })
    await syncStub(files.defs)
    const lateDrain = asDiagAttachments(await getLSPDiagnosticAttachments(ctx))
    const laterPulls = (await stubPulls(files.defs)).pullCount - pullsAfterFirstDrain
    check(
      'after the rename has been told once, four attachments with no write behind them make 0 requests and a late report is delivered untouched',
      laterPulls === 0 && totalDiagCount(lateDrain) === 1 && modelFacingText(lateDrain).includes('Late report with no write behind it.'),
      `requests=${laterPulls} (pulledReportsFor in src/integrations/lsp/LSPDiagnosticRegistry.ts must open no ticket once settleWritesAwaitingReport has settled the write); ${modelFacingText(lateDrain).slice(0, 240)}`,
    )

    registry.resetAllLSPDiagnosticState()
    await manager.closeAllFiles()
    const multi = writeFourFiles(pullDir, 'ts', 'oldMulti')
    const multiCtx = makeContext()
    await configureStub(multi.defs, QUIET_STUB)
    const multiPreview = await renameOp(pullDir, multiCtx, multi.defs, 'newMulti')
    await renameOp(pullDir, multiCtx, multi.defs, 'newMulti', { apply: true, plan: multiPreview.plan })
    registry.registerPendingLSPDiagnostic({
      serverName: 'companion-linter',
      files: [{
        uri: multi.a,
        diagnostics: [{
          message: 'Companion push finding on a.ts.',
          severity: 'Warning',
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
          source: 'companion-linter',
          code: 'L1',
        }],
      }],
    })
    await manager.sendRequest(multi.defs, 'test/releaseHalfState', { versioned: false })
    await syncStub(multi.defs)
    const stalePair = registry.peekLastPublishedReport(PULL_SERVER, multi.a)?.file.diagnostics.length
    const stalePending = registry._pendingForTesting().some(entry => entry.serverName === PULL_SERVER && entry.uris.includes(multi.a))
    const multiServerDrain = asDiagAttachments(await getLSPDiagnosticAttachments(multiCtx))
    const multiServerText = modelFacingText(multiServerDrain)
    check(
      'pull reconciliation is per-server: cleaning stub-pull half-state on a.ts preserves independent companion-linter finding',
      stalePair === 3 && stalePending && totalDiagCount(multiServerDrain) === 1 && multiServerText.includes('Companion push finding on a.ts.') && !multiServerText.includes('oldMulti') && registry.peekLastPublishedReport(PULL_SERVER, multi.a)?.file.diagnostics.length === 0,
      `stale pair before the attachment: ${stalePair} diagnostics, pending=${stalePending}; ${multiServerText.slice(0, 320)}`,
    )

    registry.resetAllLSPDiagnosticState()
    await manager.closeAllFiles()
    const files5 = writeFourFiles(pullDir, 'ts', 'oldEps')
    const unrelatedPath = path.join(pullDir, 'unrelated.ts')
    const crewPath = path.join(pullDir, 'crew.ts')
    writeFileSync(unrelatedPath, 'export const u: number = "bad"\n')
    writeFileSync(crewPath, 'export const cr: number = "bad"\n')
    const mainCtx = makeContext()
    const crewCtx = makeContext('agent-peer')
    const crewOwner = processOwnerForLane('agent-peer')
    registry.claimDiagnosticsLook(crewPath, crewOwner)
    await configureStub(files5.defs, {
      releaseHalfOnSaveCount: 4,
      releaseHalfOnFirstChange: false,
      versioned: false,
      settledPushOnSaveCount: 0,
      silentStems: [],
      defectFile: '',
      clearHeld: true,
      clearPersistent: true,
    })

    const preview5 = await renameOp(pullDir, mainCtx, files5.defs, 'newEps')
    await manager.sendRequest(files5.defs, 'test/publish', {
      uri: pathToFileURL(unrelatedPath).href,
      persistent: true,
      diagnostics: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, severity: 1, source: 'half-rename-stub', code: '2322', message: 'Unrelated main defect.' }],
    })
    await manager.sendRequest(files5.defs, 'test/publish', {
      uri: pathToFileURL(crewPath).href,
      persistent: true,
      diagnostics: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, severity: 1, source: 'half-rename-stub', code: '2322', message: 'Peer crew defect.' }],
    })
    await syncStub(files5.defs)

    await renameOp(pullDir, mainCtx, files5.defs, 'newEps', { apply: true, plan: preview5.plan })
    const mainDrain = asDiagAttachments(await getLSPDiagnosticAttachments(mainCtx))
    const crewDrain = asDiagAttachments(await getLSPDiagnosticAttachments(crewCtx))
    const mainText = modelFacingText(mainDrain)
    const crewText = modelFacingText(crewDrain)
    check(
      'unrelated main file survives rename and arrives alone on main lane',
      totalDiagCount(mainDrain) === 1 && mainText.includes('Unrelated main defect.') && !mainText.includes('Peer crew defect.') && !mainText.includes('oldEps'),
      mainText.slice(0, 320),
    )
    check(
      'separate writer lane stays independent and receives only its own defect',
      totalDiagCount(crewDrain) === 1 && crewText.includes('Peer crew defect.') && !crewText.includes('Unrelated main defect.'),
      crewText.slice(0, 320),
    )

    registry.resetAllLSPDiagnosticState()
    await manager.closeAllFiles()
    const files6 = writeFourFiles(pullDir, 'ts', 'oldZeta')
    const nonApplyCtx = makeContext()
    await configureStub(files6.defs, {
      releaseHalfOnSaveCount: 0,
      releaseHalfOnFirstChange: false,
      versioned: false,
      settledPushOnSaveCount: 0,
      silentStems: [],
      defectFile: '',
      clearHeld: true,
      clearPersistent: true,
    })

    const publishValidForA = async (msg: string) => {
      await manager.sendRequest(files6.defs, 'test/publish', {
        uri: pathToFileURL(files6.a).href,
        persistent: true,
        diagnostics: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, severity: 1, source: 'half-rename-stub', code: '2322', message: msg }],
      })
      await syncStub(files6.defs)
    }

    await publishValidForA('Valid before preview.')
    const prev6 = await renameOp(pullDir, nonApplyCtx, files6.defs, 'newZeta')
    const afterPrev = asDiagAttachments(await getLSPDiagnosticAttachments(nonApplyCtx))
    check('dry preview does not discard valid pending report', totalDiagCount(afterPrev) === 1 && modelFacingText(afterPrev).includes('Valid before preview.'), modelFacingText(afterPrev))

    await publishValidForA('Valid before drift.')
    writeFileSync(files6.c, readFileSync(files6.c, 'utf8') + '// drift\n')
    const drifted = await renameOp(pullDir, nonApplyCtx, files6.defs, 'newZeta', { apply: true, plan: prev6.plan })
    const afterDrift = asDiagAttachments(await getLSPDiagnosticAttachments(nonApplyCtx))
    check('drift refusal does not discard valid pending report', drifted.applied === false && totalDiagCount(afterDrift) === 1 && modelFacingText(afterDrift).includes('Valid before drift.'), modelFacingText(afterDrift))

    const prev6b = await renameOp(pullDir, nonApplyCtx, files6.defs, 'newZeta')
    await publishValidForA('Valid before cancel.')
    const aborted = new AbortController()
    aborted.abort()
    const cancelCtx = makeContext(undefined, aborted)
    const cancelled = await renameOp(pullDir, cancelCtx, files6.defs, 'newZeta', { apply: true, plan: prev6b.plan })
    const afterCancel = asDiagAttachments(await getLSPDiagnosticAttachments(makeContext()))
    check('cancellation does not discard valid pending report', cancelled.applied === false && totalDiagCount(afterCancel) === 1 && modelFacingText(afterCancel).includes('Valid before cancel.'), modelFacingText(afterCancel))
  }

  section('§5 the rename is asked once, at its own lane, and nothing newer than the ask is touched')
  {
    const urisOf = (rows: DiagAttachment[]): string => rows.flatMap(row => row.files.map(file => file.uri)).join(',')

    registry.resetAllLSPDiagnosticState()
    await manager.closeAllFiles()
    const quiet = writeFourFiles(pullDir, 'ts', 'oldQuiet')
    const quietCtx = makeContext()
    await configureStub(quiet.defs, { ...QUIET_STUB, defectFile: 'b.ts', defectMessage: REAL_DEFECT })
    const quietPreview = await renameOp(pullDir, quietCtx, quiet.defs, 'newQuiet')
    const quietApplied = await renameOp(pullDir, quietCtx, quiet.defs, 'newQuiet', { apply: true, plan: quietPreview.plan })
    const quietToolPulls = (await stubPulls(quiet.defs)).pullCount
    const quietDrain = asDiagAttachments(await getLSPDiagnosticAttachments(quietCtx))
    const quietAsked = (await stubPulls(quiet.defs)).pullCount - quietToolPulls
    const quietAgain = asDiagAttachments(await getLSPDiagnosticAttachments(quietCtx))
    const quietAskedAgain = (await stubPulls(quiet.defs)).pullCount - quietToolPulls - quietAsked
    durableFindings += totalDiagCount(quietDrain)
    check(
      'a rename that leaves one real error on a server that never publishes again: it arrives once, alone',
      /Post-apply diagnostics: 0 error\(s\), 0 warning\(s\)/.test(quietApplied.result) && totalDiagCount(quietDrain) === 1 && urisOf(quietDrain) === quiet.b && modelFacingText(quietDrain).includes(REAL_DEFECT) && quietAsked === 4 && quietAgain.length === 0 && quietAskedAgain === 0,
      `told ${totalDiagCount(quietDrain)} in ${urisOf(quietDrain)} after ${quietAsked} requests, then ${totalDiagCount(quietAgain)} after ${quietAskedAgain} — the landing function of pulledReportsFor in src/integrations/lsp/LSPDiagnosticRegistry.ts must enter the answer for a file whose push was dropped or never came; ${modelFacingText(quietDrain).slice(0, 240)}`,
    )

    registry.resetAllLSPDiagnosticState()
    await manager.closeAllFiles()
    const race = writeFourFiles(pullDir, 'ts', 'oldRace')
    const raceCtx = makeContext()
    await configureStub(race.defs, { ...QUIET_STUB, releaseHalfOnSaveCount: 4 })
    const racePreview = await renameOp(pullDir, raceCtx, race.defs, 'newRace')
    await renameOp(pullDir, raceCtx, race.defs, 'newRace', { apply: true, plan: racePreview.plan })
    await syncStub(race.defs)
    await configureStub(race.defs, { holdNextPullForFile: 'a.ts' })
    const raceStale = registry.peekLastPublishedReport(PULL_SERVER, race.a)?.file.diagnostics.length
    const raceAttach = getLSPDiagnosticAttachments(raceCtx)
    let raceHeld = 0
    for (const until = Date.now() + 3_000; raceHeld === 0 && Date.now() < until; ) raceHeld = (await stubPulls(race.defs)).heldPulls
    await manager.sendRequest(race.defs, 'test/publish', { uri: pathToFileURL(race.a).href, diagnostics: [stubFinding('NEW-GENUINE', 1)] })
    await syncStub(race.defs)
    await manager.sendRequest(race.defs, 'test/releaseHeldPull', { items: [] })
    const raceDrain = asDiagAttachments(await raceAttach)
    const raceText = modelFacingText(raceDrain)
    const raceAgain = asDiagAttachments(await getLSPDiagnosticAttachments(raceCtx))
    check(
      'a newer publish that lands while a written file\'s pull is outstanding survives the older empty answer',
      raceStale === 3 && raceHeld === 1 && totalDiagCount(raceDrain) === 1 && raceText.includes('NEW-GENUINE') && !raceText.includes('oldRace') && raceAgain.length === 0 && registry.peekLastPublishedReport(PULL_SERVER, race.a)?.file.diagnostics[0]?.message === 'NEW-GENUINE',
      `stale before=${raceStale}, held pulls=${raceHeld}, told ${totalDiagCount(raceDrain)} — the landing function of pulledReportsFor in src/integrations/lsp/LSPDiagnosticRegistry.ts must do nothing once the pair's newest report is no longer the one it saw at the ask; ${raceText.slice(0, 240)}`,
    )

    registry.resetAllLSPDiagnosticState()
    await manager.closeAllFiles()
    const mute = writeFourFiles(pullDir, 'ts', 'oldMute')
    const muteCtx = makeContext()
    await configureStub(mute.defs, { ...QUIET_STUB, releaseHalfOnSaveCount: 4 })
    const mutePreview = await renameOp(pullDir, muteCtx, mute.defs, 'newMute')
    await renameOp(pullDir, muteCtx, mute.defs, 'newMute', { apply: true, plan: mutePreview.plan })
    await syncStub(mute.defs)
    await configureStub(mute.defs, { holdNextPullForFile: 'a.ts' })
    const muteStart = Date.now()
    const muteDrain = asDiagAttachments(await getLSPDiagnosticAttachments(muteCtx))
    const muteMs = Date.now() - muteStart
    waitSamples.push({ label: 'pull-one-unanswered', applyMs: 0, attachMs: muteMs })
    await manager.sendRequest(mute.defs, 'test/releaseHeldPull', { items: [] })
    await syncStub(mute.defs)
    const muteAgain = asDiagAttachments(await getLSPDiagnosticAttachments(muteCtx))
    check(
      'a pull not answered inside the one deadline is unknown: its file is neither called clean nor emptied, the answered files are, and the late answer lands nowhere',
      totalDiagCount(muteDrain) === 3 && urisOf(muteDrain) === mute.a && muteMs >= 1_400 && muteMs < 3_000 && muteAgain.length === 0 && registry.peekLastPublishedReport(PULL_SERVER, mute.a)?.file.diagnostics.length === 3,
      `told ${totalDiagCount(muteDrain)} in ${urisOf(muteDrain)} after ${muteMs} ms (one RESYNC_REPORT_WAIT_MS, not two); ledger for a.ts holds ${registry.peekLastPublishedReport(PULL_SERVER, mute.a)?.file.diagnostics.length} — deliverAfterRevalidation in src/engine/attachments/diagnostics.ts must wait once and pulledReportsFor's landing function must refuse an answer whose write is settled`,
    )

    registry.resetAllLSPDiagnosticState()
    await manager.closeAllFiles()
    const mine = writeFourFiles(pullDir, 'ts', 'oldMine')
    const theirs = writeFourFiles(peerDir, 'ts', 'oldTheirs')
    const mineCtx = makeContext()
    const theirsCtx = makeContext('agent-writer')
    await configureStub(mine.defs, { ...QUIET_STUB, defectFile: 'b.ts', defectMessage: REAL_DEFECT })
    const minePreview = await renameOp(pullDir, mineCtx, mine.defs, 'newMine')
    const theirsPreview = await renameOp(peerDir, theirsCtx, theirs.defs, 'newTheirs')
    await renameOp(pullDir, mineCtx, mine.defs, 'newMine', { apply: true, plan: minePreview.plan })
    const theirsApplied = await renameOp(peerDir, theirsCtx, theirs.defs, 'newTheirs', { apply: true, plan: theirsPreview.plan })
    await manager.sendRequest(mine.defs, 'test/releaseHalfState', { versioned: false })
    await syncStub(mine.defs)
    const lanePulls = (await stubPulls(mine.defs)).pullCount
    const mineDrain = asDiagAttachments(await getLSPDiagnosticAttachments(mineCtx))
    const mineAsked = (await stubPulls(mine.defs)).pullCount - lanePulls
    const theirsDrain = asDiagAttachments(await getLSPDiagnosticAttachments(theirsCtx))
    const theirsAsked = (await stubPulls(mine.defs)).pullCount - lanePulls - mineAsked
    check(
      'two writers on two lanes: each lane asks for its own 4 files and is told its own real error once, alone',
      theirsApplied.applied === true && mineAsked === 4 && theirsAsked === 4 && totalDiagCount(mineDrain) === 1 && urisOf(mineDrain) === mine.b && totalDiagCount(theirsDrain) === 1 && urisOf(theirsDrain) === theirs.b,
      `main lane: ${totalDiagCount(mineDrain)} in ${urisOf(mineDrain)} after ${mineAsked} requests; peer lane: ${totalDiagCount(theirsDrain)} in ${urisOf(theirsDrain)} after ${theirsAsked} requests; peer apply: ${theirsApplied.result.slice(0, 160)}`,
    )

    registry.resetAllLSPDiagnosticState()
    await manager.closeAllFiles()
    const dual = writeFourFiles(dualDir, 'dd', 'oldDual')
    const dualCtx = makeContext()
    await configureStub(dual.defs, { ...QUIET_STUB, settledPushOnSaveCount: 4 })
    const dualPreview = await renameOp(dualDir, dualCtx, dual.defs, 'newDual')
    const dualApplied = await renameOp(dualDir, dualCtx, dual.defs, 'newDual', { apply: true, plan: dualPreview.plan })
    const dualToolPulls = (await stubPulls(dual.defs)).pullCount
    await manager.sendRequest(dual.defs, 'test/publish', { uri: pathToFileURL(dual.a).href, diagnostics: [{ ...stubFinding('Pushed finding its pull never returns.', 1), source: 'second-source' }] })
    await syncStub(dual.defs)
    const dualDrain = asDiagAttachments(await getLSPDiagnosticAttachments(dualCtx))
    const dualAgain = asDiagAttachments(await getLSPDiagnosticAttachments(dualCtx))
    const dualAsked = (await stubPulls(dual.defs)).pullCount - dualToolPulls
    durableFindings += totalDiagCount(dualDrain)
    check(
      'a pull server that is not known to answer with all it pushes is not asked: a finding it pushed after the rename, absent from its pull, is told once',
      /Post-apply diagnostics: 0 error\(s\), 0 warning\(s\)/.test(dualApplied.result) && dualToolPulls === 1 && dualAsked === 0 && totalDiagCount(dualDrain) === 1 && urisOf(dualDrain) === dual.a && modelFacingText(dualDrain).includes('Pushed finding its pull never returns.') && dualAgain.length === 0,
      `tool pulls=${dualToolPulls}, attachment pulls=${dualAsked} (pullServersOf in src/integrations/lsp/publishedDiagnostics.ts must ask only a server whose config says pullIsPush: its answer would stand in for every report the server pushed before it); told ${totalDiagCount(dualDrain)} then ${totalDiagCount(dualAgain)}: ${modelFacingText(dualDrain).slice(0, 240)}`,
    )

    registry.resetAllLSPDiagnosticState()
    await manager.closeAllFiles()
    const partial = writeFourFiles(pushDir, 'zz', 'oldPartial')
    const partialCtx = makeContext()
    await configureStub(partial.defs, { ...QUIET_STUB, settledPushOnSaveCount: 4, silentStems: ['a', 'b', 'c'] })
    const partialPreview = await renameOp(pushDir, partialCtx, partial.defs, 'newPartial')
    const partialApplied = await renameOp(pushDir, partialCtx, partial.defs, 'newPartial', { apply: true, plan: partialPreview.plan })
    const partialDrain = asDiagAttachments(await getLSPDiagnosticAttachments(partialCtx))
    const silentPaths = [partial.a, partial.b, partial.c]
    const silentStates: string[] = []
    for (const silentPath of silentPaths) silentStates.push((await awaitDiagnosticStabilization(manager, silentPath, { deadlineMs: 120, quietWindowMs: 40 })).state)
    const partialPulls = (await stubPulls(partial.defs)).pullCount
    check(
      'four push-only files, one reports clean, three never report: the three are never called clean and none is asked',
      /Post-apply diagnostics: 0 error\(s\), 0 warning\(s\)/.test(partialApplied.result) && registry.peekLastPublishedReport(PUSH_SERVER, partial.defs)?.file.diagnostics.length === 0 && silentPaths.every(silentPath => registry.peekLastPublishedReport(PUSH_SERVER, silentPath) === undefined) && silentStates.join(',') === 'timed-out,timed-out,timed-out' && partialDrain.length === 0 && partialPulls === 0,
      `result=${partialApplied.result}; silent files: ${silentStates.join(',')}; reports for them: ${silentPaths.filter(silentPath => registry.peekLastPublishedReport(PUSH_SERVER, silentPath) !== undefined).length}; requests=${partialPulls}`,
    )
  }

  section('§6 the ticket in the registry: who gets one, and when an answer lands')
  {
    registry.resetAllLSPDiagnosticState()
    const at = (name: string): string => path.join(scratch, 'tickets', name)
    const finding = (message: string): DiagnosticFile['diagnostics'][number] => ({ message, severity: 'Error', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, source: 'ticket-fixture' })
    const publish = (serverName: string, uri: string, message: string): void => {
      const file = { uri, diagnostics: [finding(message)] }
      registry.recordPublishedReport(serverName, file)
      registry.registerPendingLSPDiagnostic({ serverName, files: [file] })
    }
    const newest = (serverName: string, uri: string): string | undefined => registry.peekLastPublishedReport(serverName, uri)?.file.diagnostics.map(diagnostic => diagnostic.message).join('|')
    const apply = (names: string[], pulled: boolean): void => registry.rearmAfterMultiFileSync(names.map(name => ({ path: at(name), docVersion: 1, pulled })))

    registry.snapshotDiagnosticsBeforeWrite(at('single.ts'), 'a\n', 'b\n', 1)
    apply(['pushed.ts', 'pushed-2.ts'], false)
    check(
      'no ticket without a multi-file apply on a pull server: not for an unwritten file, a single-file write, or a push-only apply',
      registry.pulledReportsFor(at('unwritten.ts')) === undefined && registry.pulledReportsFor(at('single.ts')) === undefined && registry.pulledReportsFor(at('pushed.ts')) === undefined,
    )

    apply(['once.ts', 'doubt.ts'], true)
    const once = registry.pulledReportsFor(at('once.ts'))
    check('a written file\'s ticket opens once: a second attachment running beside the first gets none', once !== undefined && registry.pulledReportsFor(at('once.ts')) === undefined)

    publish('one', at('doubt.ts'), 'in doubt')
    publish('one', at('pushed.ts'), 'pushed')
    check('a push settles a push-only write and leaves a pulled write waiting for its answer', registry.writesAwaitingReport().includes(at('doubt.ts')) && !registry.writesAwaitingReport().includes(at('pushed.ts')), registry.writesAwaitingReport().join(','))

    const landOne = once?.('one')
    const landTwo = once?.('two')
    landOne?.([finding('from one')])
    landTwo?.([finding('from two')])
    check('two servers on one file each land their own answer', newest('one', at('once.ts')) === 'from one' && newest('two', at('once.ts')) === 'from two', `${newest('one', at('once.ts'))} / ${newest('two', at('once.ts'))}`)

    apply(['newer.ts', 'newer-2.ts'], true)
    const landOlder = registry.pulledReportsFor(at('newer.ts'))?.('one')
    publish('one', at('newer.ts'), 'NEWER')
    landOlder?.([])
    check('an answer does nothing once a publish was queued after its ask', landOlder !== undefined && newest('one', at('newer.ts')) === 'NEWER', String(newest('one', at('newer.ts'))))

    apply(['rewritten.ts', 'rewritten-2.ts'], true)
    const landOldText = registry.pulledReportsFor(at('rewritten.ts'))?.('one')
    registry.snapshotDiagnosticsBeforeWrite(at('rewritten.ts'), 'a\n', 'b\n', 2)
    landOldText?.([finding('about the text before the newer write')])
    check('an answer does nothing once its file was written again', landOldText !== undefined && newest('one', at('rewritten.ts')) === undefined, String(newest('one', at('rewritten.ts'))))

    apply(['settled.ts', 'settled-2.ts'], true)
    const landLate = registry.pulledReportsFor(at('settled.ts'))?.('one')
    registry.settleWritesAwaitingReport(undefined, [at('settled.ts')])
    landLate?.([finding('after the attachment settled the write')])
    check('an answer does nothing once the attachment has settled its write', landLate !== undefined && newest('one', at('settled.ts')) === undefined, String(newest('one', at('settled.ts'))))

    const told = registry.checkForLSPDiagnostics().flatMap(set => set.files.flatMap(file => file.diagnostics.map(diagnostic => diagnostic.message))).sort().join('|')
    check('the model is told the landed answers and the standing publishes, nothing else', told === 'NEWER|from one|from two|in doubt|pushed', told)

    registry.resetAllLSPDiagnosticState()
    const independent = path.join(pullDir, 'independent.ts')
    const requestsBefore = (await stubPulls(independent)).pullCount
    publish(PULL_SERVER, independent, 'old')
    const first = deliverAfterRevalidation([], 400, undefined, manager)
    publish(PULL_SERVER, independent, 'NEW-GENUINE')
    const delivered = [...(await first), ...(await deliverAfterRevalidation([], 400))]
    const requests = (await stubPulls(independent)).pullCount - requestsBefore
    check(
      'the captain\'s no-write scene on the real pull server: a pending report with no write behind it makes 0 requests and the newer finding is told',
      requests === 0 && JSON.stringify(delivered).includes('NEW-GENUINE'),
      `requests=${requests}; delivered=${JSON.stringify(delivered).slice(0, 240)}`,
    )
  }
} finally {
  registry.resetAllLSPDiagnosticState()
  await mgrModule.shutdownLspServerManager()
  process.chdir(repo)
  rmSync(scratch, { recursive: true, force: true })
}

console.log(`\nsummary: checks=${checks} failures=${failures} staleAttachments=${staleAttachments} durableFindings=${durableFindings} waits=${JSON.stringify(waitSamples)}`)
if (failures > 0) {
  console.error('prove-lsp-rename-stale-diagnostics: RED')
  process.exit(1)
}
console.log('prove-lsp-rename-stale-diagnostics: GREEN')
