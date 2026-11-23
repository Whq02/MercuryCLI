#!/usr/bin/env bun
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'faults-fn33-')))
const HOME = join(SCRATCH, 'home')
const TMP = join(SCRATCH, 'tmp')
mkdirSync(HOME, { recursive: true })
mkdirSync(TMP, { recursive: true })

process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_TMPDIR = TMP
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
delete process.env.MERCURY_HOME
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const POSIX_MODES = process.platform !== 'win32' && (typeof process.getuid !== 'function' || process.getuid() !== 0)
let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

async function runPidAlive(): Promise<void> {
  console.log('\npidAlive — EPERM means alive, ESRCH means dead')
  const { pidAlive } = await import('../../src/platform/processes/pidAlive.ts')
  const origKill = process.kill
  try {
    process.kill = ((_pid: number, _sig?: string | number) => {
      throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' })
    }) as typeof process.kill
    check('pidAlive returns true on EPERM', pidAlive(424242) === true)

    process.kill = ((_pid: number, _sig?: string | number) => {
      throw Object.assign(new Error('no such process'), { code: 'ESRCH' })
    }) as typeof process.kill
    check('pidAlive returns false on ESRCH', pidAlive(424242) === false)
  } finally {
    process.kill = origKill
  }
}

async function runLocalJsxCommandError(): Promise<void> {
  console.log('\nprocessSlashCommand — local-jsx load failure reports stderr and commandError')
  const { processSlashCommand } = await import('../../src/engine/user-input/processSlashCommand.tsx')
  const brokenCommand = {
    type: 'local-jsx' as const,
    name: 'broken-jsx-proof',
    description: 'broken',
    isEnabled: () => true,
    load: async () => {
      throw new Error('boom-jsx-load')
    },
  }
  const fakeContext = {
    options: { commands: [brokenCommand] },
  } as unknown as Parameters<typeof processSlashCommand>[4]
  const res = await processSlashCommand('/broken-jsx-proof', [], [], [], fakeContext, () => {})
  check(
    'local-jsx failure returns commandError and stderr message',
    typeof res.commandError === 'string' &&
      res.commandError.includes('boom-jsx-load') &&
      res.messages.length >= 2,
    JSON.stringify({ commandError: res.commandError, messageCount: res.messages.length }),
  )
}

async function runProjectBoundary(): Promise<void> {
  console.log('\nprojectBoundary — gitInitRefusal does not refuse a small markerless folder for an unreadable subfolder')
  if (!POSIX_MODES) return
  const { gitInitRefusal } = await import('../../src/platform/files/projectBoundary.ts')
  const folder = join(SCRATCH, 'markerless-unreadable')
  const locked = join(folder, 'locked')
  const readable = join(SCRATCH, 'markerless-readable')
  mkdirSync(locked, { recursive: true })
  mkdirSync(readable, { recursive: true })
  writeFileSync(join(readable, 'note.txt'), 'hi')
  chmodSync(locked, 0o000)
  try {
    const refused = gitInitRefusal(folder)
    check(
      'gitInitRefusal does not refuse a small markerless folder for a subfolder it could not count',
      refused === null,
      JSON.stringify(refused),
    )
    check('gitInitRefusal still allows small readable markerless folder', gitInitRefusal(readable) === null)
  } finally {
    chmodSync(locked, 0o700)
  }
}

async function runPromptDraft(): Promise<void> {
  console.log('\npromptDraft — draftPasteHashes throws when drafts dir exists and is unreadable')
  if (!POSIX_MODES) return
  const { draftPasteHashes } = await import('../../src/screen/composer/input-core/promptDraft.ts')
  const draftsDir = join(HOME, 'drafts')
  rmSync(draftsDir, { recursive: true, force: true })
  check('draftPasteHashes returns empty set when drafts dir is absent', draftPasteHashes().size === 0)
  mkdirSync(draftsDir, { recursive: true })
  chmodSync(draftsDir, 0o000)
  let threwCode: string | null = null
  try {
    draftPasteHashes()
  } catch (error) {
    threwCode = (error as NodeJS.ErrnoException | null)?.code ?? 'THREW'
  } finally {
    chmodSync(draftsDir, 0o700)
    rmSync(draftsDir, { recursive: true, force: true })
  }
  check('draftPasteHashes throws EACCES when drafts dir is unreadable', threwCode === 'EACCES', String(threwCode))
}

async function runPromptEditor(): Promise<void> {
  console.log('\npromptEditor — statSync/read failure returns EditorResult.error instead of silent null')
  const instances = (await import('../../src/screen/renderer/instances.ts')).default
  const { editFileInEditor } = await import('../../src/screen/composer/promptEditor.ts')
  const prevEditor = process.env.EDITOR
  const prevVisual = process.env.VISUAL
  const fakeInstance = {
    awaitTerminalQueries: async () => {},
    enterAlternateScreen: () => {},
    exitAlternateScreen: () => {},
    pause: () => {},
    resume: () => {},
    suspendStdin: () => {},
    resumeStdin: () => {},
  }
  instances.set(process.stdout, fakeInstance as never)
  const rmScript = join(SCRATCH, 'remove-file.sh')
  writeFileSync(rmScript, '#!/bin/sh\nrm -f "$1"\n', { mode: 0o755 })
  process.env.EDITOR = rmScript
  delete process.env.VISUAL
  try {
    const missing = await editFileInEditor(join(SCRATCH, 'does-not-exist-editor.txt'))
    check(
      'editFileInEditor reports ENOENT error when file does not exist',
      missing.content === null && typeof missing.error === 'string' && /ENOENT|no such file/i.test(missing.error),
      JSON.stringify(missing),
    )
    const vanished = join(SCRATCH, 'editor-vanished.txt')
    writeFileSync(vanished, 'before')
    const afterRemove = await editFileInEditor(vanished)
    check(
      'editFileInEditor reports ENOENT error when reading edited file fails',
      afterRemove.content === null && typeof afterRemove.error === 'string' && /ENOENT|no such file/i.test(afterRemove.error),
      JSON.stringify(afterRemove),
    )
  } finally {
    instances.delete(process.stdout)
    if (prevEditor === undefined) delete process.env.EDITOR
    else process.env.EDITOR = prevEditor
    if (prevVisual === undefined) delete process.env.VISUAL
    else process.env.VISUAL = prevVisual
  }
}

async function runProofHomeGuard(): Promise<void> {
  console.log('\nproofHomeGuard — unreadable parent dir refuses instead of failing open')
  if (!POSIX_MODES) return
  const { accountStoreHome, refuseProofWriteIntoAccountStore } = await import('../../src/models/roads/proofHomeGuard.ts')
  const lockedDir = join(SCRATCH, 'locked-proof-home')
  mkdirSync(lockedDir, { recursive: true })
  const linkPath = join(lockedDir, 'to-account')
  symlinkSync(accountStoreHome(), linkPath, 'dir')
  chmodSync(lockedDir, 0o000)
  const prevProof = process.env.MERCURY_PROOF
  process.env.MERCURY_PROOF = '1'
  let threwCode: string | null = null
  try {
    refuseProofWriteIntoAccountStore(linkPath, 'proof test store')
  } catch (error) {
    threwCode = (error as NodeJS.ErrnoException | null)?.code ?? 'THREW'
  } finally {
    chmodSync(lockedDir, 0o700)
    if (prevProof === undefined) delete process.env.MERCURY_PROOF
    else process.env.MERCURY_PROOF = prevProof
  }
  check(
    'refuseProofWriteIntoAccountStore throws EACCES on unreadable symlink parent instead of allowing',
    threwCode === 'EACCES',
    String(threwCode),
  )
  let okSafe = true
  try {
    process.env.MERCURY_PROOF = '1'
    refuseProofWriteIntoAccountStore(join(SCRATCH, 'fresh-nonexistent-home'), 'proof test store')
  } catch {
    okSafe = false
  } finally {
    if (prevProof === undefined) delete process.env.MERCURY_PROOF
    else process.env.MERCURY_PROOF = prevProof
  }
  check('refuseProofWriteIntoAccountStore still allows nonexistent scratch home', okSafe)
}

async function runSavedPromptsStore(): Promise<void> {
  console.log('\nsavedPromptsStore — failed legacy rename returns legacy path so prompts stay readable')
  if (!POSIX_MODES) return
  const { savedPromptsPath, savedPromptsRoot, listSavedPrompts } = await import('../../src/sessions/saved-prompts/savedPromptsStore.ts')
  const { sanitizePath } = await import('../../src/sessions/transcripts/sessionStoragePortable.ts')
  const project = '/Users/example/dev/legacy-saved-prompts-proj'
  const root = savedPromptsRoot()
  mkdirSync(root, { recursive: true })
  const legacyPath = join(root, `${sanitizePath(project.normalize('NFC'))}.json`)
  writeFileSync(
    legacyPath,
    JSON.stringify({ _v: 1, drafts: [{ id: 'abc123', text: 'kept legacy prompt', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }] }),
  )
  chmodSync(root, 0o500)
  try {
    const chosen = savedPromptsPath(project)
    const listed = await listSavedPrompts(project)
    check(
      'savedPromptsPath falls back to legacy path when rename fails',
      chosen === legacyPath && listed.length === 1 && listed[0]?.text === 'kept legacy prompt',
      JSON.stringify({ chosen, legacyPath, count: listed.length }),
    )
  } finally {
    chmodSync(root, 0o700)
  }
}

async function runScratchLeases(): Promise<void> {
  console.log('\nscratchLeases — unreadable or corrupt registry refuses without overwriting existing leases')
  if (!POSIX_MODES) return
  const { registerScratchLease, releaseScratchLease, listScratchLeftovers } = await import('../../src/platform/files/scratchLeases.ts')
  const { getProjectTempDir } = await import('../../src/permissions/rules/filesystem.ts')
  const dir = getProjectTempDir()
  mkdirSync(dir, { recursive: true })
  const regPath = join(dir, 'scratch-leases.json')
  const original = JSON.stringify({
    v: 1,
    leases: [
      {
        leaseId: 'sl-existing-1',
        owner: { kind: 'agent', id: 'kept-agent' },
        root: join(dir, 'kept-root'),
        createdAt: 1,
        lastUsedAt: 1,
        cleanupPolicy: 'on-complete',
        recovery: 'keep me',
      },
    ],
  })

  writeFileSync(regPath, original, { mode: 0o600 })
  chmodSync(regPath, 0o200)
  let regThrewUnreadable = false
  let relUnreadable: { released: boolean; refusal?: string } = { released: true }
  let listThrewUnreadable = false
  try {
    try {
      registerScratchLease({ kind: 'agent', id: 'new-agent' }, join(dir, 'new-root'))
    } catch {
      regThrewUnreadable = true
    }
    relUnreadable = releaseScratchLease('sl-existing-1')
    try {
      listScratchLeftovers()
    } catch {
      listThrewUnreadable = true
    }
  } finally {
    chmodSync(regPath, 0o600)
  }
  check('registerScratchLease throws and preserves unreadable registry', regThrewUnreadable && readFileSync(regPath, 'utf8') === original)
  check(
    'releaseScratchLease refuses unreadable registry instead of claiming no lease',
    !relUnreadable.released && !/^no lease /.test(relUnreadable.refusal ?? '') && readFileSync(regPath, 'utf8') === original,
    JSON.stringify(relUnreadable),
  )
  check('listScratchLeftovers throws on unreadable registry', listThrewUnreadable)

  const corrupt = '{"v":1,"leases":[broken'
  writeFileSync(regPath, corrupt, { mode: 0o600 })
  let regThrewCorrupt = false
  try {
    registerScratchLease({ kind: 'agent', id: 'new-agent' }, join(dir, 'new-root'))
  } catch {
    regThrewCorrupt = true
  }
  const relCorrupt = releaseScratchLease('sl-existing-1')
  check('registerScratchLease throws and preserves corrupt registry', regThrewCorrupt && readFileSync(regPath, 'utf8') === corrupt)
  check(
    'releaseScratchLease refuses corrupt registry instead of claiming no lease',
    !relCorrupt.released && !/^no lease /.test(relCorrupt.refusal ?? '') && readFileSync(regPath, 'utf8') === corrupt,
    JSON.stringify(relCorrupt),
  )
  rmSync(regPath, { force: true })
}

async function runSessionEnvironment(): Promise<void> {
  console.log('\nsessionEnvironment — unreadable fragments folder is not cached as absent')
  if (!POSIX_MODES || process.platform === 'win32') return
  const { getSessionId } = await import('../../src/boot/process-state/processState.ts')
  const { getSessionEnvironmentScript, invalidateSessionEnvCache } = await import('../../src/platform/environment/sessionEnvironment.ts')
  const dir = join(HOME, 'session-env', getSessionId())
  mkdirSync(dir, { recursive: true })
  const hookFile = join(dir, 'session-start-hook-0.sh')
  writeFileSync(hookFile, 'export MERCURY_HOOK_PROOF=yes\n')
  invalidateSessionEnvCache()
  chmodSync(dir, 0o000)
  let whileUnreadable: string | null = 'sentinel'
  let afterReadable: string | null = null
  try {
    whileUnreadable = await getSessionEnvironmentScript()
  } finally {
    chmodSync(dir, 0o700)
  }
  afterReadable = await getSessionEnvironmentScript()
  check('unreadable fragments folder answers null without throwing', whileUnreadable === null, String(whileUnreadable))
  check(
    'next call loads the hook script once fragments folder is readable again',
    afterReadable === 'export MERCURY_HOOK_PROOF=yes',
    String(afterReadable),
  )
  invalidateSessionEnvCache()
}

async function runClearedSessions(): Promise<void> {
  console.log('\nclearedSessions — unreadable or corrupt map is never overwritten by markSessionCleared')
  if (!POSIX_MODES) return
  const { markSessionCleared, unmarkSessionCleared, resetClearedSessionsMemo } = await import(
    '../../src/sessions/transcripts/clearedSessions.ts'
  )
  const filePath = join(HOME, 'cleared-sessions.json')
  const original = JSON.stringify({ 'kept-session-1': 1700000000000 }, null, 2) + '\n'
  writeFileSync(filePath, original, { mode: 0o600 })
  chmodSync(filePath, 0o200)
  try {
    resetClearedSessionsMemo()
    markSessionCleared('new-session-2')
    unmarkSessionCleared('kept-session-1')
  } finally {
    chmodSync(filePath, 0o600)
  }
  check(
    'markSessionCleared preserves unreadable cleared-sessions.json byte for byte',
    readFileSync(filePath, 'utf8') === original,
    readFileSync(filePath, 'utf8'),
  )

  const corrupt = '{"kept-session-1": broken'
  writeFileSync(filePath, corrupt, { mode: 0o600 })
  resetClearedSessionsMemo()
  markSessionCleared('new-session-3')
  check(
    'markSessionCleared preserves corrupt cleared-sessions.json byte for byte',
    readFileSync(filePath, 'utf8') === corrupt,
    readFileSync(filePath, 'utf8'),
  )
  rmSync(filePath, { force: true })
  resetClearedSessionsMemo()
  const { isSessionCleared } = await import('../../src/sessions/transcripts/clearedSessions.ts')
  markSessionCleared('normal-session-1')
  check('normal markSessionCleared and unmarkSessionCleared still round-trip', isSessionCleared('normal-session-1') === true)
  unmarkSessionCleared('normal-session-1')
  check('unmarkSessionCleared removes the mark', isSessionCleared('normal-session-1') === false)
  rmSync(filePath, { force: true })
  resetClearedSessionsMemo()
}

async function runSessionFlip(): Promise<void> {
  console.log('\nsessionFlip — failure returns a note carrying the error instead of silent false')
  const { flipToSession } = await import('../../src/engine/connector/sessionFlip.ts')
  const projectsDir = join(HOME, 'projects')
  const projDir = join(projectsDir, 'flip-proof-proj')
  mkdirSync(projDir, { recursive: true })
  const sid = '11111111-1111-4111-8111-111111111111'
  const cwd = process.cwd()
  const now = new Date().toISOString()
  const { encodeSeedTranscript } = await import('../lib/seedTranscript.ts')
  writeFileSync(
    join(projDir, `${sid}.jsonl`),
    encodeSeedTranscript(
      [
        {
          type: 'user',
          isSidechain: false,
          parentUuid: null,
          uuid: '22222222-2222-4222-8222-222222222222',
          sessionId: sid,
          timestamp: now,
          cwd,
          message: { role: 'user', content: 'hello flip proof' },
        },
      ],
      sid,
    ),
  )
  const outcome = await flipToSession(async () => {
    throw new Error('resume-boom')
  }, sid)
  check(
    'flipToSession returns flipped:false with a note carrying the error message',
    outcome.flipped === false && typeof outcome.note === 'string' && outcome.note.includes('resume-boom'),
    JSON.stringify(outcome),
  )
}

async function runAgentTranscript(): Promise<void> {
  console.log('\nsessionStorage/loading + logs — getAgentTranscript throws on unreadable transcript instead of null')
  if (!POSIX_MODES) return
  const { asAgentId } = await import('../../src/sessions/transcripts/ids.ts')
  const { getAgentTranscriptPath } = await import('../../src/sessions/transcripts/paths.ts')
  const { getAgentTranscript } = await import('../../src/sessions/transcripts/sessionListings.ts')
  const missingId = asAgentId('fn33-missing-agent')
  check('getAgentTranscript returns null when transcript is absent', (await getAgentTranscript(missingId)) === null)

  const lockedId = asAgentId('fn33-locked-agent')
  const lockedPath = getAgentTranscriptPath(lockedId)
  mkdirSync(join(lockedPath, '..'), { recursive: true })
  writeFileSync(lockedPath, '{"type":"user"}\n', { mode: 0o600 })
  chmodSync(lockedPath, 0o000)
  let threwCode: string | null = null
  try {
    await getAgentTranscript(lockedId)
  } catch (error) {
    threwCode = (error as NodeJS.ErrnoException | null)?.code ?? 'THREW'
  } finally {
    chmodSync(lockedPath, 0o600)
    rmSync(lockedPath, { force: true })
  }
  check('getAgentTranscript throws EACCES when transcript exists and is unreadable', threwCode === 'EACCES', String(threwCode))
}

try {
  await runPidAlive()
  await runLocalJsxCommandError()
  await runProjectBoundary()
  await runPromptDraft()
  await runPromptEditor()
  await runProofHomeGuard()
  await runSavedPromptsStore()
  await runScratchLeases()
  await runSessionEnvironment()
  await runClearedSessions()
  await runSessionFlip()
  await runAgentTranscript()
} finally {
  rmSync(SCRATCH, { recursive: true, force: true })
}

void chmodSync
void readFileSync
void symlinkSync
void writeFileSync
void POSIX_MODES

console.log(failures === 0 ? '\nGREEN' : `\nRED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
