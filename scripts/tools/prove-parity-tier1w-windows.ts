#!/usr/bin/env bun

let failures = 0
let hintFor = ''
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}${!ok && hintFor ? ` | to fix: ${hintFor}` : ''}`)
  if (!ok) failures = 1
}

const { getPlatform } = await import('../../src/platform/environment/platform.ts')
getPlatform.cache.set(undefined, 'windows')
const { checkReadPermissionForTool } = await import('../../src/permissions/rules/filesystem.ts')
const fakeTool = (path: string) => ({ name: 'ParityProbe', getPath: () => path })
const ctx = {
  mode: 'default',
  additionalWorkingDirectories: new Map(),
  alwaysAllowRules: {},
  alwaysDenyRules: {},
} as never

hintFor = 'checkReadPermissionForTool in src/permissions/rules/filesystem.ts must ask for UNC and extended-length Windows paths with the reason that matches each shape'
const uncDecision = checkReadPermissionForTool(fakeTool('\\\\server\\share\\x') as never, {}, ctx) as {
  behavior?: string
  message?: string
}
t(
  'a real UNC share asks as a network path',
  uncDecision.behavior === 'ask' && /SMB\/WebDAV/.test(uncDecision.message ?? ''),
  uncDecision.message,
)
const extendedDecision = checkReadPermissionForTool(fakeTool('\\\\?\\C:\\proj\\x') as never, {}, ctx) as {
  behavior?: string
  message?: string
}
t(
  'an extended-length LOCAL path asks with its true (suspicious-pattern) reason',
  extendedDecision.behavior === 'ask' &&
    /suspicious Windows path pattern/.test(extendedDecision.message ?? '') &&
    !/network/.test(extendedDecision.message ?? ''),
  extendedDecision.message,
)
const extendedUncDecision = checkReadPermissionForTool(
  fakeTool('\\\\?\\UNC\\server\\share\\x') as never,
  {},
  ctx,
) as { behavior?: string; message?: string }
t(
  'the \\\\?\\UNC spelling still reads as network',
  extendedUncDecision.behavior === 'ask' && /SMB\/WebDAV/.test(extendedUncDecision.message ?? ''),
  extendedUncDecision.message,
)
getPlatform.cache.delete(undefined)

const { isDangerousRemovalPath } = await import('../../src/permissions/rules/pathValidation.ts')
hintFor = 'isDangerousRemovalPath in src/permissions/rules/pathValidation.ts must keep treating drive roots and their direct children as dangerous, extended-length spelling included'
t('\\\\?\\C:\\ is still a drive root', isDangerousRemovalPath('\\\\?\\C:\\') === true)
t(
  '\\\\?\\C:\\Windows is still a drive-root direct child',
  isDangerousRemovalPath('\\\\?\\C:\\Windows') === true,
)
t('plain C:\\ stays protected', isDangerousRemovalPath('C:\\') === true)
t('an ordinary nested path stays unflagged', isDangerousRemovalPath('/home/u/project/tmp') === false)

const { processAtMentionedFiles } = await import('../../src/engine/attachments/mentionResolvers.ts')
const mentionContext = {
  getAppState: () => ({ toolPermissionContext: ctx }),
  options: {},
  abortController: new AbortController(),
} as never
hintFor = 'processAtMentionedFiles in src/engine/attachments/mentionResolvers.ts must skip UNC-shaped mentions before any filesystem call and still resolve plain absolute paths'
const uncAttachments = await processAtMentionedFiles('look at @//tmp please', mentionContext)
t('a UNC-shaped mention produces no attachment (zero fs calls)', uncAttachments.length === 0)
const plainAttachments = await processAtMentionedFiles('look at @/tmp please', mentionContext)
t('a plain absolute mention still resolves', plainAttachments.length > 0)

const { createPowerShellProvider } = await import('../../src/platform/shell/powershellProvider.ts')
const provider = createPowerShellProvider('/usr/local/bin/pwsh')

hintFor = 'buildExecCommand and getEnvironmentOverrides in createPowerShellProvider in src/platform/shell/powershellProvider.ts own the plain-text rendering pin, its 5.1 guard, the exit trailer and the win32-only Python override'
const plain = await provider.buildExecCommand('Write-Output hi', { id: 7 })
const prelude = "$PSStyle.OutputRendering = 'PlainText'"
const preludeAt = plain.commandString.indexOf(prelude)
const commandAt = plain.commandString.indexOf('Write-Output hi')
const trailerAt = plain.commandString.indexOf('SetShouldExit($mc)')
t('plain lane: rendering pinned before the command', preludeAt !== -1 && commandAt > preludeAt)
t('plain lane: the cwd/exit trailer still follows the command', trailerAt > commandAt)
t(
  'plain lane: the 5.1 guard wraps the pin',
  plain.commandString.includes('Get-Variable -Name PSStyle -ErrorAction SilentlyContinue'),
)

const overrides = await provider.getEnvironmentOverrides('Write-Output hi')
t(
  'POSIX env carries no Python stdio override (win32-scoped pin)',
  !('PYTHONIOENCODING' in overrides),
)

process.exit(failures)
