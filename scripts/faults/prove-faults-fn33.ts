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

try {
  await runPidAlive()
  await runLocalJsxCommandError()
  await runProjectBoundary()
  await runPromptDraft()
  await runPromptEditor()
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
