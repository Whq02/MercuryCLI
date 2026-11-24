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
    section('O-17: PowerShell -Recurse:$true and Windows glued slash switches (rd /s/q, del /s/f/q)')
    const rootCases: Array<[string, 'Bash' | 'PowerShell']> = [
      ['Remove-Item -Recurse:$true -Force C:\\', 'PowerShell'],
      ['ri -r:$true -fo $env:USERPROFILE', 'PowerShell'],
      ['Remove-Item -Recurse:$true C:\\Windows', 'PowerShell'],
      ['rd /s/q C:\\', 'PowerShell'],
      ['rd /s/q C:\\Users\\Alice', 'PowerShell'],
      ['del /s/f/q C:\\Users\\Alice\\*', 'PowerShell'],
    ]
    for (const [cmd, tool] of rootCases) {
      const rule = await evalCmd(cmd, tool)
      check(`root refused (${tool}): ${cmd}`, rule === 'no-root-recursive-delete', rule)
    }

    const safeCases: Array<[string, 'Bash' | 'PowerShell']> = [
      ['Remove-Item -Recurse:$true -Force C:\\Users\\Alice\\proj\\dist', 'PowerShell'],
      ['Remove-Item -Recurse:$false C:\\', 'PowerShell'],
      ['rd /s/q build', 'PowerShell'],
    ]
    for (const [cmd, tool] of safeCases) {
      const rule = await evalCmd(cmd, tool)
      check(`non-root or -Recurse:$false stays allowed (${tool}): ${cmd}`, rule === '(allowed)', rule)
    }
  } finally {
    restorePlatform()
    if (savedHome !== undefined) process.env.HOME = savedHome
    else delete process.env.HOME
    if (savedProfile !== undefined) process.env.USERPROFILE = savedProfile
    else delete process.env.USERPROFILE
  }

  console.log(`\nprove-delete-ward-flag-spellings: ${failures === 0 ? 'ALL HOLD' : `${failures} FAILURE(S)`}`)
  process.exit(failures === 0 ? 0 : 1)
}

await main()
export {}
