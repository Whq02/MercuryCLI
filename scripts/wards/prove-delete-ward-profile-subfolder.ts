#!/usr/bin/env bun

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
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

type PendingToolCall = import('../../src/utils/wards/wards.js').PendingToolCall
type WardVerdict = import('../../src/utils/wards/wards.js').WardVerdict
const { AUTONOMOUS_WARDS, evaluateWards } = await import('../../src/utils/wards/wards.js')
const { deleteWardActive } = await import('../../src/guards/wardsGuard.js')
const { deleteFlagEnv, setFlagEnv } = await import('../../src/substrate/flagRegistry.js')

const bash = (command: string, resolvePath?: PendingToolCall['resolvePath']): PendingToolCall => ({
  toolName: 'Bash',
  input: { command },
  shellCommand: command,
  ...(resolvePath ? { resolvePath } : {}),
})
const autonomous = (command: string, resolvePath?: PendingToolCall['resolvePath']): WardVerdict => evaluateWards(AUTONOMOUS_WARDS, bash(command, resolvePath))
const wordsOf = (verdict: WardVerdict): string => (verdict.allow ? 'ALLOWED (hole!)' : `denied by ${verdict.rule.name}`)
const wardedByHome = (verdict: WardVerdict): boolean => !verdict.allow && verdict.rule.name === 'no-home-recursive-delete'

const OTHER_PROFILE_SUBFOLDERS = [
  "rm -rf 'C:\\Users\\Public\\m35-x'",
  'rm -rf C:\\Users\\Public\\m35-x',
  'rm -rf "C:\\Users\\Other Person\\Documents\\m35-x"',
  'rm -rf C:/Users/Public/m35-x',
  'rm -rf /c/Users/Public/m35-x',
  "rm -rf '/c/Users/Public/m35-x'",
  'rm -r -f c:\\users\\public\\m35-x',
  'rm --recursive --force D:\\Users\\Public\\m35-x',
  'Remove-Item -Recurse C:\\Users\\Public\\m35-x',
  "Remove-Item -Recurse -Force 'C:\\Users\\Public\\m35-decoy'",
  'Remove-Item -Recurse -Force C:/Users/Public/m35-x',
  'remove-item -recurse -force C:\\Users\\Public\\m35-x',
  'Remove-Item C:\\Users\\Public\\m35-x -Recurse -Force',
  'ri -r -fo C:\\Users\\Public\\m35-x',
  'rd /s /q C:\\Users\\Public\\m35-x',
  'rmdir /S /Q "C:\\Users\\Public\\m35 x"',
  'del /s /q C:\\Users\\Public\\m35-x\\*',
  'Remove-Item -Recurse -Force $env:USERPROFILE\\m35-x',
  'rd /s /q %USERPROFILE%\\m35-x',
  'Remove-Item -Recurse ~\\m35-x',
  'find /c/Users/Public/m35-x -name "*.log" -delete',
]
const MAC_PARITY = ['rm -rf /Users/other/sub', 'rm -rf /home/other/sub', "rm -rf '/Users/other/sub dir'"]
const UNTOUCHED = [
  'rm -rf C:\\src\\m35-play\\scratch',
  'Remove-Item -Recurse -Force C:\\src\\m35-play\\scratch',
  'rm -rf /c/src/m35-play/scratch',
  'rm -rf scratch/junk',
  'Remove-Item C:\\Users\\Public\\m35-x\\notes.txt',
  'ls -la C:\\Users\\Public\\m35-x',
  'Get-ChildItem C:\\Users\\Public\\m35-x -Recurse',
  'rm -rf $env:TEMP\\m35-x',
]

try {
  setFlagEnv('MERCURY_SPAWNED_BY', 'proof:profile-subfolder#1')
  check('the ward rides a spawned session (MERCURY_SPAWNED_BY set): deleteWardActive', deleteWardActive())

  for (const platform of ['win32', 'darwin'] as const) {
    pinPlatform(platform)
    section(`§ ${platform} read — a recursive delete inside another user's profile is refused by no-home-recursive-delete in a spawned session (F35W-02, F35W-06)`)
    for (const command of OTHER_PROFILE_SUBFOLDERS) check(`${platform}: ${command}`, wardedByHome(autonomous(command)), wordsOf(autonomous(command)))
    for (const command of MAC_PARITY) check(`${platform}: ${command} (the Mac shape, the same ward)`, wardedByHome(autonomous(command)), wordsOf(autonomous(command)))
    for (const command of UNTOUCHED) check(`${platform}: ${command} stays with the card`, autonomous(command).allow, wordsOf(autonomous(command)))
  }

  pinPlatform('win32')
  section('§ win32 read — a delete inside the spawned session\'s own project under a profile passes once the resolver places it inside the project')
  const inside = (root: string): PendingToolCall['resolvePath'] => (path: string) => ({ path: path.replace(/\\/g, '/'), root })
  const own = 'rm -rf C:\\Users\\WHQ\\code\\m35-play\\scratch'
  check('the string road alone wards it (no resolver: the home shape is enough)', wardedByHome(autonomous(own)), wordsOf(autonomous(own)))
  check('resolved inside the project the delete passes to the card', autonomous(own, inside('C:\\Users\\WHQ\\code\\m35-play')).allow, wordsOf(autonomous(own, inside('C:\\Users\\WHQ\\code\\m35-play'))))
  check('the quoted and forward-slash spellings pass the same way', autonomous("Remove-Item -Recurse -Force 'C:\\Users\\WHQ\\code\\m35-play\\scratch'", inside('C:/Users/WHQ/code/m35-play')).allow && autonomous('rm -rf /c/Users/WHQ/code/m35-play/scratch', inside('/c/Users/WHQ/code/m35-play')).allow)
  const elsewhere = autonomous("rm -rf 'C:\\Users\\Public\\m35-x'", inside('C:\\Users\\WHQ\\code\\m35-play'))
  check('another user\'s folder resolved outside the project stays warded', wardedByHome(elsewhere), wordsOf(elsewhere))
  restorePlatform()

  section('§ an operator session carries no spawn stamp: the ward is not armed (the sovereign law; the box\'s run had no stamp)')
  deleteFlagEnv('MERCURY_SPAWNED_BY')
  check('without MERCURY_SPAWNED_BY the delete ward is off, and the card or the sovereign posture decides', !deleteWardActive())
} finally {
  restorePlatform()
  deleteFlagEnv('MERCURY_SPAWNED_BY')
}

console.log(`\ndelete ward · profile subfolder: ${checks} checks, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
