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
  const { pidAlive } = await import('../../src/utils/pidAlive.ts')
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
  const { processSlashCommand } = await import('../../src/utils/processUserInput/processSlashCommand.tsx')
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
  console.log('\nprojectBoundary — gitInitRefusal refuses markerless folder with unreadable subfolder')
  if (!POSIX_MODES) return
  const { gitInitRefusal } = await import('../../src/utils/projectBoundary.ts')
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
      'gitInitRefusal refuses markerless folder containing unreadable subfolder',
      refused?.kind === 'not-a-project' && refused.words.includes('could not be read'),
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
  const { draftPasteHashes } = await import('../../src/utils/promptDraft.ts')
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
  const instances = (await import('../../src/ink/instances.ts')).default
  const { editFileInEditor } = await import('../../src/utils/promptEditor.ts')
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
  const { accountStoreHome, refuseProofWriteIntoAccountStore } = await import('../../src/utils/proofHomeGuard.ts')
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
  const { savedPromptsPath, savedPromptsRoot, listSavedPrompts } = await import('../../src/utils/savedPrompts/savedPromptsStore.ts')
  const { sanitizePath } = await import('../../src/utils/sessionStoragePortable.ts')
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

try {
  await runPidAlive()
  await runLocalJsxCommandError()
  await runProjectBoundary()
  await runPromptDraft()
  await runPromptEditor()
  await runProofHomeGuard()
  await runSavedPromptsStore()
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
