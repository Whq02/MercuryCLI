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

  try {
    section('O-18a: POSIX character-class globs over root/home and rsync --delete on another user')
    pinPlatform('darwin')
    process.env.HOME = '/Users/alice'
    delete process.env.USERPROFILE

    const evalPosix = async (command: string) => {
      const verdict = await refusalOfShellCommand(
        { toolName: 'Bash', input: { command }, shellCommand: command, startingFolder: '/Users/alice/proj' },
        '/Users/alice/proj',
      )
      return verdict.allow ? '(allowed)' : verdict.rule.name
    }

    for (const cmd of ['rm -rf /[a-z]*', 'rm -rf /[!.]*', 'rm -rf ~/[!.]*', 'rm -rf /Users/alice/[a-z]*']) {
      const rule = await evalPosix(cmd)
      check(`root/home glob refused: ${cmd}`, rule === 'no-root-recursive-delete', rule)
    }
    const rsyncRule = await evalPosix('rsync -a --delete /tmp/empty/ /Users/bob/docs/')
    check('rsync --delete against another user refused: rsync -a --delete /tmp/empty/ /Users/bob/docs/', rsyncRule === 'no-other-user-delete', rsyncRule)

    for (const cmd of ['rm -rf /Users/alice/proj/[a-z]*', 'rsync -a --delete /tmp/empty/ /Users/alice/proj/dist/']) {
      const rule = await evalPosix(cmd)
      check(`ordinary project command stays allowed: ${cmd}`, rule === '(allowed)', rule)
    }

    section('O-18b: win32 character-class globs over drive root and home')
    pinPlatform('win32')
    process.env.USERPROFILE = 'C:\\Users\\Alice'
    delete process.env.HOME

    const evalWin = async (command: string) => {
      const verdict = await refusalOfShellCommand(
        { toolName: 'PowerShell', input: { command }, shellCommand: command, startingFolder: 'C:\\Users\\Alice\\proj' },
        'C:\\Users\\Alice\\proj',
      )
      return verdict.allow ? '(allowed)' : verdict.rule.name
    }

    for (const cmd of ['Remove-Item -Recurse -Force C:\\[a-z]*', 'Remove-Item -Recurse -Force C:\\Users\\Alice\\[!.]*']) {
      const rule = await evalWin(cmd)
      check(`win32 root/home glob refused: ${cmd}`, rule === 'no-root-recursive-delete', rule)
    }
    const winSafe = await evalWin('Remove-Item -Recurse -Force C:\\Users\\Alice\\proj\\[a-z]*')
    check('win32 project glob stays allowed', winSafe === '(allowed)', winSafe)
  } finally {
    restorePlatform()
    if (savedHome !== undefined) process.env.HOME = savedHome
    else delete process.env.HOME
    if (savedProfile !== undefined) process.env.USERPROFILE = savedProfile
    else delete process.env.USERPROFILE
  }

  console.log(`\nprove-delete-ward-globs-and-rsync: ${failures === 0 ? 'ALL HOLD' : `${failures} FAILURE(S)`}`)
  process.exit(failures === 0 ? 0 : 1)
}

await main()
export {}
