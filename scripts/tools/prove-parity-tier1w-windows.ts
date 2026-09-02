#!/usr/bin/env bun
// ============================================================================
//  prove-parity-tier1w-windows — the POSIX-provable mechanisms from
//  frontier-sweep #1, tier 1W (Windows path + shell-lane classes).
//  The win32-only arms (PYTHONIOENCODING override, where.exe caching, the
//  read-only-destination rename reclassification) ride the Windows field
//  task on a real NTFS box — this prover pins what a POSIX host can.
//
//   1. Path-classification honesty: a real UNC share asks as a NETWORK
//      path; a `\\?\C:\` extended-length LOCAL path asks as a suspicious
//      Windows pattern (its true reason), and the `\\?\UNC\` spelling is
//      still recognized as network.
//   2. isDangerousRemovalPath sees through the extended-length prefix:
//      `\\?\C:\` is still a drive root, `\\?\C:\Windows` still a direct
//      child of one.
//   3. The at-mention resolver gives UNC-shaped paths ZERO filesystem
//      calls: `//tmp` (which a bare stat would happily resolve on POSIX)
//      produces no attachment.
//   4. The PowerShell command assembly pins plain-text rendering ahead of
//      the user command in BOTH lanes (plain and sandbox-encoded), with
//      the cwd/exit trailer still behind it; the POSIX environment carries
//      no Python stdio override (the pin is win32-scoped).
// ============================================================================

let failures = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures = 1
}

// —— 1. UNC vs extended-length classification ————————————————————————
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

// —— 2. dangerous-removal prefix strip ———————————————————————————————
const { isDangerousRemovalPath } = await import('../../src/utils/permissions/pathValidation.ts')
t('\\\\?\\C:\\ is still a drive root', isDangerousRemovalPath('\\\\?\\C:\\') === true)
t(
  '\\\\?\\C:\\Windows is still a drive-root direct child',
  isDangerousRemovalPath('\\\\?\\C:\\Windows') === true,
)
t('plain C:\\ stays protected', isDangerousRemovalPath('C:\\') === true)
t('an ordinary nested path stays unflagged', isDangerousRemovalPath('/home/u/project/tmp') === false)

// —— 3. at-mention UNC short-circuit —————————————————————————————————
const { processAtMentionedFiles } = await import('../../src/utils/attachments/mentionResolvers.ts')
const mentionContext = {
  getAppState: () => ({ toolPermissionContext: ctx }),
  options: {},
} as never
// `//tmp` exists via a bare POSIX stat — an attachment appearing would mean
// the resolver touched the filesystem for a UNC-shaped path.
const uncAttachments = await processAtMentionedFiles('look at @//tmp please', mentionContext)
t('a UNC-shaped mention produces no attachment (zero fs calls)', uncAttachments.length === 0)
const plainAttachments = await processAtMentionedFiles('look at @/tmp please', mentionContext)
t('a plain absolute mention still resolves', plainAttachments.length > 0)

// —— 4. PowerShell assembly + POSIX env ——————————————————————————————
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
