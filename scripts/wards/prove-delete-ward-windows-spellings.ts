;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')
function pinPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value, configurable: true })
}
function restorePlatform(): void {
  if (platformDescriptor) Object.defineProperty(process, 'platform', platformDescriptor)
}

const HOME_DELETES = [
  'Remove-Item -Recurse -Force $env:USERPROFILE',
  'Remove-Item -Recurse -Force ${env:USERPROFILE}',
  'Remove-Item -Recurse -Force $HOME',
  'Remove-Item -Recurse -Force ~',
  'Remove-Item -Recurse -Force C:\\Users\\Alice',
  'Remove-Item -Recurse -Force c:/users/alice',
  "Remove-Item -Recurse -Force 'C:\\Users\\Alice\\'",
  'Remove-Item -Recurse -Force C:\\Users\\Alice\\*',
  'Remove-Item -r $env:USERPROFILE',
  'Remove-Item -Rec -Fo $env:USERPROFILE',
  'ri -Recurse -Force $env:USERPROFILE',
  'rm -r -fo $env:USERPROFILE',
  'rm -rf $env:USERPROFILE',
  'rm -rf C:\\Users\\Alice',
  'rm -rf C:/Users/Alice',
  'rm -rf /c/Users/Alice',
  'rm -rf ~',
  'rm -rf $HOME',
  'rm -rf %USERPROFILE%',
  'rd /s /q C:\\Users\\Alice',
  'rd /s /q %USERPROFILE%',
  'rmdir /s /q C:\\Users\\Alice',
  'del /s /q C:\\Users\\Alice\\*',
  'del /s /q %USERPROFILE%',
  'del /s /q %HOMEDRIVE%%HOMEPATH%',
  'cmd /c rd /s /q C:\\Users\\Alice',
  'cmd /c "rd /s /q %USERPROFILE%"',
  'Remove-Item -Recurse -Force $env:HOMEDRIVE$env:HOMEPATH',
]
const ROOT_DELETES = [
  'Remove-Item -Recurse -Force C:\\',
  'Remove-Item -Recurse -Force C:/',
  'Remove-Item -Recurse -Force Z:\\',
  'Remove-Item -Recurse -Force Z:/',
  'rd /s /q C:\\',
  'rd /s /q Z:\\',
  'rm -rf /c',
]
const LEFT_TO_THE_PERMISSION_CHECK = [
  'Remove-Item -Recurse -Force C:\\Users\\Other',
  'Remove-Item -Recurse -Force C:\\Users',
  'Remove-Item -Recurse -Force C:\\Windows',
  'Remove-Item -Recurse -Force \\\\server\\share',
]
const ORDINARY_DELETES = [
  'Remove-Item -Recurse -Force C:\\Users\\Alice\\proj\\scratch',
  'Remove-Item -Recurse -Force c:/users/alice/proj/dist',
  'Remove-Item -Recurse -Force .\\dist',
  'Remove-Item -Recurse -Force dist, build',
  'Remove-Item -Recurse -Force $env:TEMP\\mercury-x',
  'Remove-Item -Recurse -Force \\\\server\\share\\proj\\build',
  'Remove-Item C:\\Users\\Alice\\notes.txt',
  'Remove-Item -Force $env:USERPROFILE\\notes.txt',
  'rm -rf node_modules',
  'rm -rf C:\\Users\\Alice\\proj\\node_modules',
  'rd /s /q build',
  'del /s /q C:\\Users\\Alice\\proj\\*.log',
  'Get-ChildItem -Recurse C:\\Users\\Alice\\proj | Measure-Object',
]

async function main(): Promise<void> {
  delete process.env.MERCURY_WARDS
  const savedHome = process.env.HOME
  const savedProfile = process.env.USERPROFILE
  const wards = await import('../../src/utils/wards/wards.js')
  const psPaths = await import('../../src/tools/PowerShellTool/pathValidation.js')
  const pending = (command: string, toolName = 'PowerShell') => ({ toolName, input: { command }, shellCommand: command })
  const refused = (command: string): boolean => !wards.evaluateWards(wards.REFUSAL_WARDS, pending(command)).allow
  const ruleOf = (command: string): string => {
    const verdict = wards.evaluateWards(wards.REFUSAL_WARDS, pending(command))
    return verdict.allow ? '(allowed)' : verdict.rule.name
  }

  console.log('============================================================')
  console.log(' the recursive-delete ward — Windows spellings on a win32 read')
  console.log('============================================================')

  section('§1 win32 — every home-delete spelling is refused by no-root-recursive-delete')
  pinPlatform('win32')
  process.env.USERPROFILE = 'C:\\Users\\Alice'
  delete process.env.HOME
  try {
    for (const command of HOME_DELETES) check(`refused: ${command}`, refused(command), ruleOf(command))
    section('§2 win32 — drive roots in both slash spellings are refused')
    for (const command of ROOT_DELETES) check(`refused: ${command}`, refused(command), ruleOf(command))
    section('§2b win32 — the pinned law stands: another user\'s home, the Users folder, a system folder and a share root are the permission check\'s (prove-windows-removal-roots)')
    for (const command of LEFT_TO_THE_PERMISSION_CHECK) check(`not warded (the permission check judges it): ${command}`, !refused(command), ruleOf(command))
    section('§3 win32 — an ordinary delete inside a project, a scratch folder or a share subfolder is not warded')
    for (const command of ORDINARY_DELETES) check(`allowed: ${command}`, !refused(command), ruleOf(command))
    section('§4 win32 — the Bash tool on Windows (git-bash) reads the same patterns')
    check('refused through the Bash tool: rm -rf $USERPROFILE', !wards.evaluateWards(wards.REFUSAL_WARDS, pending('rm -rf $USERPROFILE', 'Bash')).allow)
    check('refused through the Bash tool: rm -rf /c/Users/Alice', !wards.evaluateWards(wards.REFUSAL_WARDS, pending('rm -rf /c/Users/Alice', 'Bash')).allow)
    check('allowed through the Bash tool: rm -rf /c/Users/Alice/proj/dist', wards.evaluateWards(wards.REFUSAL_WARDS, pending('rm -rf /c/Users/Alice/proj/dist', 'Bash')).allow)

    section('§5 win32 — the PowerShell tool\'s own hard deny (the parsed operand) reads the home from USERPROFILE first')
    const deny = (path: string): boolean => psPaths.isDangerousRemovalRawPath(path)
    for (const path of ['~', 'C:\\Users\\Alice', 'c:/users/alice', 'C:\\Users\\Alice\\*', 'C:\\Users', 'C:\\Windows', 'C:\\', 'Z:/', '\\\\?\\C:\\Users\\Alice']) check(`hard deny (the permission check\'s own refusal): ${path}`, deny(path))
    for (const path of ['C:\\Users\\Alice\\proj\\scratch', '.\\dist', 'C:\\Users\\Alice\\Documents']) check(`no hard deny (an ordinary ask or allow): ${path}`, !deny(path))
    process.env.HOME = '/c/Users/Alice'
    check('hard deny of the literal home survives a git-bash HOME=/c/Users/Alice in the environment', deny('C:\\Users\\Alice') && deny('c:/users/alice'))
    process.env.HOME = 'C:\\Users\\Alice'
    check('hard deny of the literal home with HOME spelled like USERPROFILE', deny('C:\\Users\\Alice'))
    delete process.env.HOME
    const live = wards.windowsRemovalPatterns()
    check('the Windows pattern set is built once per home and reused', live === wards.windowsRemovalPatterns())
    process.env.USERPROFILE = 'D:\\Profiles\\Jo'
    check('a different USERPROFILE rebuilds the set and the new home is refused', live !== wards.windowsRemovalPatterns() && refused('Remove-Item -Recurse -Force D:\\Profiles\\Jo') && refused('rm -rf /d/Profiles/Jo'))
    check('the old home is then an ordinary operand (the pinned law: another user\'s home is the permission check\'s)', !refused('Remove-Item -Recurse -Force C:\\Users\\Alice') && !refused('Remove-Item -Recurse -Force C:\\Users\\Alice\\proj'))
  } finally {
    restorePlatform()
    if (savedHome === undefined) delete process.env.HOME
    else process.env.HOME = savedHome
    if (savedProfile === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = savedProfile
  }

  section('§6 the Mac road is unchanged — the Windows set never joins off win32')
  check(`platform restored (${process.platform})`, process.platform !== 'win32')
  check('rm -rf / still refused on this host', refused('rm -rf /'))
  check('rm -rf ~ still refused on this host', refused('rm -rf ~'))
  check('rd /s /q C:\\ (the drive-root pattern is platform-neutral) still refused on this host', refused('rd /s /q C:\\'))
  check('Remove-Item -Recurse -Force $env:USERPROFILE is NOT judged by the Windows set on this host', !refused('Remove-Item -Recurse -Force $env:USERPROFILE'))
  check('rm -rf node_modules allowed on this host', !refused('rm -rf node_modules'))

  console.log(`\n${failures === 0 ? 'OK' : 'FAIL'} — ${failures} failure(s)`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
