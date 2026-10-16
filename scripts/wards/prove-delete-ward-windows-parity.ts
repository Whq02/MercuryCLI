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

const OTHER_HOMES = [
  'Remove-Item -Recurse -Force C:\\Users\\Other',
  'Remove-Item -Recurse -Force C:\\Users\\Other\\',
  'Remove-Item -Recurse -Force C:\\Users\\Other\\*',
  "Remove-Item -Recurse -Force 'C:\\Users\\Other Person'",
  'Remove-Item -Recurse -Force c:/users/other',
  'Remove-Item -Recurse -Force C:\\Users',
  'Remove-Item -Recurse -Force D:\\Users\\',
  'ri -r -fo C:\\Users\\Other',
  'rm -r -fo C:\\Users',
  'rm -rf C:/Users/Other',
  'rm -rf /c/Users/Other',
  'rm -rf /c/Users',
  'rm -rf "/c/Users/Other Person"',
  'rd /s /q C:\\Users\\Other',
  'rd /s /q C:\\Users',
  'rmdir /s /q c:\\users\\other',
  'del /s /q C:\\Users\\Other\\*',
  'rd /s /q %SystemDrive%\\Users\\Other',
  'rd /s /q %HOMEDRIVE%\\Users',
  'Remove-Item -Recurse -Force $env:SystemDrive\\Users\\Other',
  'cmd /c rd /s /q C:\\Users\\Other',
]
const SYSTEM_FOLDERS = [
  'Remove-Item -Recurse -Force C:\\Windows',
  'Remove-Item -Recurse -Force C:\\Windows\\System32',
  'Remove-Item -Recurse -Force c:/windows/temp',
  'Remove-Item -Recurse -Force "C:\\Program Files"',
  'Remove-Item -Recurse -Force "C:\\Program Files\\Some App"',
  "Remove-Item -Recurse -Force 'C:\\Program Files (x86)\\Some App'",
  'Remove-Item -Recurse -Force C:\\ProgramData',
  'Remove-Item -Recurse -Force C:\\ProgramData\\Some\\Thing',
  'Remove-Item -Recurse -Force $env:SystemRoot',
  'Remove-Item -Recurse -Force $env:windir\\System32',
  'Remove-Item -Recurse -Force $env:ProgramFiles',
  'Remove-Item -Recurse -Force ${env:ProgramFiles(x86)}',
  'Remove-Item -Recurse -Force $env:ProgramData',
  'Remove-Item -Recurse -Force "$env:ProgramFiles\\Some App"',
  'ri -r -fo C:\\Windows',
  'rm -r -fo $env:ProgramData',
  'rm -rf C:/Windows',
  'rm -rf /c/Windows',
  'rm -rf "/c/Program Files/Some App"',
  'rm -rf /c/ProgramData',
  'rd /s /q C:\\Windows',
  'rd /s /q C:\\Windows\\System32',
  'rmdir /s /q "C:\\Program Files (x86)"',
  'rd /s /q "C:\\Program Files\\Some App"',
  'del /s /q C:\\ProgramData\\*',
  'rd /s /q %SystemRoot%',
  'rd /s /q %windir%\\System32',
  'rd /s /q "%ProgramFiles%"',
  'rd /s /q "%ProgramFiles(x86)%\\Some App"',
  'rd /s /q %ProgramW6432%',
  'rd /s /q %ProgramData%',
  'rd /s /q %SystemDrive%\\Windows',
  'cmd /c rd /s /q C:\\Windows',
  'cmd /c "rd /s /q %ProgramData%"',
]
const SHARE_ROOTS = [
  'Remove-Item -Recurse -Force \\\\server\\share',
  'Remove-Item -Recurse -Force \\\\server\\share\\',
  'Remove-Item -Recurse -Force \\\\server\\share\\*',
  'Remove-Item -Recurse -Force //server/share',
  "Remove-Item -Recurse -Force '\\\\nas.local\\Users'",
  'Remove-Item -Recurse -Force \\\\server\\C$',
  'ri -r -fo \\\\server\\share',
  'rm -rf //server/share',
  'rd /s /q \\\\server\\share',
  'rmdir /s /q \\\\server\\share\\',
  'del /s /q \\\\server\\share\\*',
  'cmd /c rd /s /q \\\\server\\share',
]
const PIPELINES = [
  'Get-ChildItem C:\\Users\\Other -Recurse | Remove-Item -Recurse -Force',
  'gci C:\\Users -r | ri -r -fo',
  'Get-ChildItem C:\\Windows -Recurse | Remove-Item -Recurse -Force',
  'gci "C:\\Program Files" -r | ri -r -fo',
  'Get-ChildItem $env:ProgramData -Recurse | Remove-Item -Recurse -Force',
  'Get-ChildItem \\\\server\\share -Recurse | Remove-Item -Recurse -Force',
]
const OTHER_USER_SUBFOLDERS = [
  'Remove-Item -Recurse -Force C:\\Users\\Other\\proj\\dist',
  'Remove-Item -Recurse -Force c:/users/other/proj/node_modules',
  'Remove-Item C:\\Users\\Other\\notes.txt',
  'rm -rf /c/Users/Other/proj/dist',
  'rd /s /q C:\\Users\\Other\\proj\\build',
  'del /s /q C:\\Users\\Other\\proj\\*.log',
  'Get-ChildItem C:\\Users\\Other\\proj -Recurse | Remove-Item -Recurse -Force',
]
const BOX_SHAPES: Array<[string, string]> = [
  ['cmd //c "rd /s /q C:\\Users\\Public\\m37-decoy-5"', 'Bash'],
  ['cmd /c "rd /s /q C:\\Users\\Other\\proj\\build"', 'Bash'],
  ['cmd.exe /c "rmdir /s /q C:\\Users\\Other\\proj\\build"', 'Bash'],
  ['cmd //c "del /s /q C:\\Users\\Other\\proj\\*.log"', 'Bash'],
  ["rm -rf \\\n'C:\\Users\\Public\\m37-decoy-5'", 'Bash'],
  ['rm -rf \\\nC:\\Users\\Other\\proj\\dist', 'Bash'],
  ['powershell -NoProfile -Command "Remove-Item -Recurse -Force \'C:\\Users\\Public\\m37-decoy-5\'"', 'Bash'],
  ['pwsh -c "Remove-Item -Recurse -Force C:\\Users\\Other\\proj\\dist"', 'Bash'],
  ['bash -c "rm -rf /c/Users/Other/proj/dist"', 'Bash'],
  ['Remove-Item -Recurse -Force `\n  C:\\Users\\Other\\proj\\dist', 'PowerShell'],
]
const BOX_CONTROLS: Array<[string, string]> = [
  ["rm -rf 'C:\\Users\\Alice\\m37-own-decoy'", 'Bash'],
  ['cmd //c "rd /s /q C:\\Users\\Alice\\m37-own-decoy"', 'Bash'],
  ["rm -rf 'C:\\src\\m37-5b-scratch\\inside-decoy'", 'Bash'],
  ['cmd //c "echo rd /s /q C:\\Users\\Public\\m37-decoy-5"', 'Bash'],
]
const ORDINARY_DELETES = [
  'Remove-Item -Recurse -Force C:\\Users\\Alice\\proj\\scratch',
  'Remove-Item -Recurse -Force \\\\server\\share\\proj\\build',
  'Remove-Item -Recurse -Force //server/share/proj/build',
  'Remove-Item -Recurse -Force C:\\Windows.old\\scratch',
  'Remove-Item -Recurse -Force C:\\Users.bak',
  'Remove-Item -Recurse -Force C:\\ProgramDataMirror',
  'Remove-Item -Recurse -Force C:\\Programs\\Some App',
  'Remove-Item -Recurse -Force $env:TEMP\\mercury-x',
  'Remove-Item -Recurse -Force $env:ProgramFilesMirror',
  'Remove-Item -Recurse -Force .\\dist',
  'Remove-Item -Force C:\\Windows\\Temp\\one.log',
  'rm -rf /c/Windows.old',
  'rm -rf node_modules',
  'rd /s /q build',
  'del /q C:\\Windows\\Temp\\one.log',
  'Get-ChildItem \\\\server\\share\\proj -Recurse | Remove-Item -Recurse -Force',
  'Get-ChildItem -Recurse C:\\Windows | Measure-Object',
  'Get-ChildItem C:\\Windows -Recurse | Remove-Item -Recurse -WhatIf',
]

async function main(): Promise<void> {
  delete process.env.MERCURY_WARDS
  const savedHome = process.env.HOME
  const savedProfile = process.env.USERPROFILE
  const wards = await import('../../src/utils/wards/wards.js')
  const pending = (command: string, toolName = 'PowerShell') => ({ toolName, input: { command }, shellCommand: command })
  const verdictOf = (command: string, toolName?: string) => wards.evaluateWards(wards.REFUSAL_WARDS, pending(command, toolName))
  const refused = (command: string, toolName?: string): boolean => !verdictOf(command, toolName).allow
  const ruleOf = (command: string, toolName?: string): string => {
    const verdict = verdictOf(command, toolName)
    return verdict.allow ? '(allowed)' : verdict.rule.name
  }
  const bashVerb = (command: string): boolean => /^rm\b/.test(command)

  console.log('============================================================')
  console.log(' the recursive-delete ward — Windows parity with the Mac ward (ruling AT)')
  console.log('============================================================')

  section('§1 win32 — another user\'s home and the Users folder are refused in every native spelling, as /Users/<anyone> is on the Mac')
  pinPlatform('win32')
  process.env.USERPROFILE = 'C:\\Users\\Alice'
  delete process.env.HOME
  try {
    for (const command of OTHER_HOMES) check(`refused: ${command}`, refused(command, bashVerb(command) ? 'Bash' : undefined), ruleOf(command, bashVerb(command) ? 'Bash' : undefined))
    section('§2 win32 — the system folders (Windows, Program Files, ProgramData) at any depth, literal or through their variables')
    for (const command of SYSTEM_FOLDERS) check(`refused: ${command}`, refused(command, bashVerb(command) ? 'Bash' : undefined), ruleOf(command, bashVerb(command) ? 'Bash' : undefined))
    section('§3 win32 — a share root in either slash spelling, as /Volumes/<x> is on the Mac')
    for (const command of SHARE_ROOTS) check(`refused: ${command}`, refused(command, bashVerb(command) ? 'Bash' : undefined), ruleOf(command, bashVerb(command) ? 'Bash' : undefined))
    section('§4 win32 — the pipeline grammar meets the same targets')
    for (const command of PIPELINES) check(`refused: ${command}`, refused(command), ruleOf(command))
    section('§5 win32 — every refusal is the one rule, so the refusal line is the direct form\'s')
    const rules = new Set([...OTHER_HOMES, ...SYSTEM_FOLDERS, ...SHARE_ROOTS, ...PIPELINES].map(command => ruleOf(command, bashVerb(command) ? 'Bash' : undefined)))
    check('one rule names every refusal: no-root-recursive-delete', rules.size === 1 && rules.has('no-root-recursive-delete'), [...rules].join(', '))
    section('§6 win32 — the own home\'s folders, a share subfolder, a look-alike name, a system-folder file or a -WhatIf stay the permission check\'s')
    for (const command of ORDINARY_DELETES) check(`not warded: ${command}`, !refused(command, bashVerb(command) ? 'Bash' : undefined), ruleOf(command, bashVerb(command) ? 'Bash' : undefined))
    section('§6b win32 — a folder or a file inside another user\'s home is refused by its own rule, recursive or not (the .37 ruling)')
    for (const command of OTHER_USER_SUBFOLDERS) check(`refused by no-other-user-delete: ${command}`, ruleOf(command, bashVerb(command) ? 'Bash' : undefined) === 'no-other-user-delete', ruleOf(command, bashVerb(command) ? 'Bash' : undefined))
    section('§6c win32 — the Windows box\'s two sovereign bypasses (F37W-5B-08, F37W-5B-13) and their kin: a delete wrapped in cmd /c, cmd //c, powershell -Command, pwsh -c or bash -c is read as the command it runs, and a backslash continuation is one line (RED on the base: the cmd //c and the continuation forms were allowed)')
    for (const [command, tool] of BOX_SHAPES) check(`refused by no-other-user-delete (${tool}): ${JSON.stringify(command)}`, ruleOf(command, tool) === 'no-other-user-delete', ruleOf(command, tool))
    section('§6d win32 — the box\'s controls stay true: the own profile (F37W-5B-11), a folder outside any Users tree (F37W-5B-09) and an echo of the words are not this ward\'s business')
    for (const [command, tool] of BOX_CONTROLS) check(`not warded by no-other-user-delete (${tool}): ${JSON.stringify(command)}`, ruleOf(command, tool) !== 'no-other-user-delete', ruleOf(command, tool))
  } finally {
    restorePlatform()
    if (savedHome === undefined) delete process.env.HOME
    else process.env.HOME = savedHome
    if (savedProfile === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = savedProfile
  }

  section('§7 off win32 — the Mac ward is the parity source and is unchanged; the Windows set never joins')
  check(`platform restored (${process.platform})`, process.platform !== 'win32')
  check('rm -rf /Users/other still refused on this host', refused('rm -rf /Users/other', 'Bash'))
  check('rm -rf /Users still refused on this host', refused('rm -rf /Users', 'Bash'))
  check('rm -rf /System still refused on this host', refused('rm -rf /System', 'Bash'))
  check('rm -rf /Volumes/Backup still refused on this host', refused('rm -rf /Volumes/Backup', 'Bash'))
  check('rm -rf /Users/other/proj/dist refused on this host by no-other-user-delete (the .37 ruling)', ruleOf('rm -rf /Users/other/proj/dist', 'Bash') === 'no-other-user-delete', ruleOf('rm -rf /Users/other/proj/dist', 'Bash'))
  check('Remove-Item -Recurse -Force C:\\Users\\Other is NOT judged by the Windows set on this host', !refused('Remove-Item -Recurse -Force C:\\Users\\Other'))
  check('Remove-Item -Recurse -Force C:\\Windows is NOT judged by the Windows set on this host', !refused('Remove-Item -Recurse -Force C:\\Windows'))

  console.log(`\n${failures === 0 ? 'OK' : 'FAIL'} — ${failures} failure(s)`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
