#!/usr/bin/env bun

let failures = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures = 1
}

const { checkReadPermissionForTool } = await import('../../src/utils/permissions/filesystem.ts')
const fakeTool = (path: string) => ({ name: 'ParityProbe', getPath: () => path })
const ctx = {
  mode: 'default',
  additionalWorkingDirectories: new Map(),
  alwaysAllowRules: {},
  alwaysDenyRules: {},
} as never

const uncDecision = checkReadPermissionForTool(fakeTool('\\\\server\\share\\x') as never, {}, ctx) as {
  behavior?: string
  message?: string
}
t(
  'a real UNC share asks as a network path',
  uncDecision.behavior === 'ask' && /network \(UNC\)/.test(uncDecision.message ?? ''),
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
  extendedUncDecision.behavior === 'ask' && /network \(UNC\)/.test(extendedUncDecision.message ?? ''),
  extendedUncDecision.message,
)

const { isDangerousRemovalPath } = await import('../../src/utils/permissions/pathValidation.ts')
t('\\\\?\\C:\\ is still a drive root', isDangerousRemovalPath('\\\\?\\C:\\') === true)
t(
  '\\\\?\\C:\\Windows is still a drive-root direct child',
  isDangerousRemovalPath('\\\\?\\C:\\Windows') === true,
)
t('plain C:\\ stays protected', isDangerousRemovalPath('C:\\') === true)
t('an ordinary nested path stays unflagged', isDangerousRemovalPath('/home/u/project/tmp') === false)

const { processAtMentionedFiles } = await import('../../src/utils/attachments/mentionResolvers.ts')
const mentionContext = {
  getAppState: () => ({ toolPermissionContext: ctx }),
  options: {},
} as never
const uncAttachments = await processAtMentionedFiles('look at @//tmp please', mentionContext)
t('a UNC-shaped mention produces no attachment (zero fs calls)', uncAttachments.length === 0)
const plainAttachments = await processAtMentionedFiles('look at @/tmp please', mentionContext)
t('a plain absolute mention still resolves', plainAttachments.length > 0)

const { createPowerShellProvider } = await import('../../src/utils/shell/powershellProvider.ts')
const provider = createPowerShellProvider('/usr/local/bin/pwsh')

const plain = await provider.buildExecCommand('Write-Output hi', { id: 7, useSandbox: false })
const prelude = "$PSStyle.OutputRendering = 'PlainText'"
const preludeAt = plain.commandString.indexOf(prelude)
const commandAt = plain.commandString.indexOf('Write-Output hi')
const trailerAt = plain.commandString.indexOf('exit $mc')
t('plain lane: rendering pinned before the command', preludeAt !== -1 && commandAt > preludeAt)
t('plain lane: the cwd/exit trailer still follows the command', trailerAt > commandAt)
t(
  'plain lane: the 5.1 guard wraps the pin',
  plain.commandString.includes('Get-Variable -Name PSStyle -ErrorAction SilentlyContinue'),
)

const sandboxed = await provider.buildExecCommand('Write-Output hi', {
  id: 8,
  useSandbox: true,
  sandboxTmpDir: '/tmp/sbx',
})
const encodedMatch = /-EncodedCommand\s+(\S+)/.exec(sandboxed.commandString)
const decoded = encodedMatch ? Buffer.from(encodedMatch[1]!, 'base64').toString('utf16le') : ''
t(
  'sandbox lane: the encoded command carries the same pin ahead of the command',
  decoded.indexOf(prelude) !== -1 && decoded.indexOf('Write-Output hi') > decoded.indexOf(prelude),
)

const overrides = await provider.getEnvironmentOverrides('Write-Output hi')
t(
  'POSIX env carries no Python stdio override (win32-scoped pin)',
  !('PYTHONIOENCODING' in overrides),
)

process.exit(failures)
