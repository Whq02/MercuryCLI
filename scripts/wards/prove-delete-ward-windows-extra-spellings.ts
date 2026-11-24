#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(title: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + title + '\n' + '─'.repeat(76))
}

const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')
function pinPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value, configurable: true })
}
function restorePlatform(): void {
  if (platformDescriptor) Object.defineProperty(process, 'platform', platformDescriptor)
}

async function main(): Promise<void> {
  delete process.env.MERCURY_WARDS
  const savedHome = process.env.HOME
  const savedProfile = process.env.USERPROFILE
  const { refusalOfShellCommand } = await import('../../src/permissions/wards/wardsRefusals.js')

  pinPlatform('win32')
  process.env.USERPROFILE = 'C:\\Users\\Alice'
  delete process.env.HOME

  const evalCmd = async (command: string, toolName: 'Bash' | 'PowerShell') => {
    const verdict = await refusalOfShellCommand(
      { toolName, input: { command }, shellCommand: command, startingFolder: 'C:\\Users\\Alice\\proj' },
      'C:\\Users\\Alice\\proj',
    )
    return verdict.allow ? '(allowed)' : verdict.rule.name
  }

  try {
    section('O-16: win32 extra spellings (/cygdrive/<drive>, \\\\?\\UNC\\<host>\\<drive>$, PowerShell FileSystem::<drive>:\\)')
    const rootCases: Array<[string, 'Bash' | 'PowerShell']> = [
      ['rm -rf /cygdrive/c', 'Bash'],
      ['rm -rf /cygdrive/c/', 'Bash'],
      ['rd /s /q \\\\?\\UNC\\localhost\\C$', 'PowerShell'],
      ['Remove-Item -Recurse -Force FileSystem::C:\\', 'PowerShell'],
      ['Remove-Item -Recurse -Force Microsoft.PowerShell.Core\\FileSystem::C:\\', 'PowerShell'],
    ]
    for (const [cmd, tool] of rootCases) {
      const rule = await evalCmd(cmd, tool)
      check(`root refused (${tool}): ${cmd}`, rule === 'no-root-recursive-delete', rule)
    }

    const otherUserCases: Array<[string, 'Bash' | 'PowerShell']> = [
      ['rm -rf /cygdrive/c/Users/Bob/docs', 'Bash'],
      ['Remove-Item -Recurse -Force \\\\?\\UNC\\localhost\\C$\\Users\\Bob\\docs', 'PowerShell'],
      ['Remove-Item -Recurse -Force FileSystem::C:\\Users\\Bob\\docs', 'PowerShell'],
    ]
    for (const [cmd, tool] of otherUserCases) {
      const rule = await evalCmd(cmd, tool)
      check(`other-user refused (${tool}): ${cmd}`, rule === 'no-other-user-delete', rule)
    }

    const safeCases: Array<[string, 'Bash' | 'PowerShell']> = [
      ['rm -rf /cygdrive/c/Users/Alice/proj/dist', 'Bash'],
      ['Remove-Item -Recurse -Force FileSystem::C:\\Users\\Alice\\proj\\dist', 'PowerShell'],
    ]
    for (const [cmd, tool] of safeCases) {
      const rule = await evalCmd(cmd, tool)
      check(`ordinary project delete stays allowed (${tool}): ${cmd}`, rule === '(allowed)', rule)
    }
  } finally {
    restorePlatform()
    if (savedHome !== undefined) process.env.HOME = savedHome
    else delete process.env.HOME
    if (savedProfile !== undefined) process.env.USERPROFILE = savedProfile
    else delete process.env.USERPROFILE
  }

  console.log(`\nprove-delete-ward-windows-extra-spellings: ${failures === 0 ? 'ALL HOLD' : `${failures} FAILURE(S)`}`)
  process.exit(failures === 0 ? 0 : 1)
}

await main()
export {}
