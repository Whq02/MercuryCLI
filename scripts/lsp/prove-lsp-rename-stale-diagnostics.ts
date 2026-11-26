#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
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
mkdirSync(pullDir, { recursive: true })
mkdirSync(pushDir, { recursive: true })

process.env.MERCURY_LSP_SERVERS = JSON.stringify({
  'stub-pull': {
    command: process.execPath,
    args: [stubPath],
    extensionToLanguage: { '.ts': 'typescript' },
    env: { HALF_RENAME_PULL: '1' },
  },
  'stub-push': {
    command: process.execPath,
    args: [stubPath],
    extensionToLanguage: { '.zz': 'zed' },
    env: { HALF_RENAME_PULL: '0' },
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
const { getLSPDiagnosticAttachments } = await import('../../src/engine/attachments/diagnostics.js')
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
    })
    const preview = await renameOp(pullDir, ctx, files.defs, 'newAlpha')
    check('preview returns plan across 4 files without writing', preview.applied === false && typeof preview.plan === 'string' && readFileSync(files.defs, 'utf8').includes('oldAlpha'), preview.result)

    const applyStart = Date.now()
    const applied = await renameOp(pullDir, ctx, files.defs, 'newAlpha', { apply: true, plan: preview.plan })
    const applyMs = Date.now() - applyStart
    const attachStart = Date.now()
    const attachments = asDiagAttachments(await getLSPDiagnosticAttachments(ctx))
    const attachMs = Date.now() - attachStart
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

    registry.registerPendingLSPDiagnostic({
      serverName: 'companion-linter',
      files: [{
        uri: files.a,
        diagnostics: [{
          message: 'Companion push finding on a.ts.',
          severity: 'Warning',
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
          source: 'companion-linter',
          code: 'L1',
        }],
      }],
    })
    await manager.sendRequest(files.defs, 'test/releaseHalfState', { versioned: false })
    await syncStub(files.defs)
    const multiServerDrain = asDiagAttachments(await getLSPDiagnosticAttachments(ctx))
    const multiServerText = modelFacingText(multiServerDrain)
    check(
      'pull reconciliation is per-server: cleaning stub-pull half-state on a.ts preserves independent companion-linter finding',
      totalDiagCount(multiServerDrain) === 1 && multiServerText.includes('Companion push finding on a.ts.') && !multiServerText.includes('oldDelta'),
      multiServerText.slice(0, 320),
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
