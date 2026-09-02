#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

const main = readFileSync(join(ROOT, 'src', 'main.tsx'), 'utf-8')
const mainBody = main.slice(main.indexOf('export async function main()'))

console.log('============================================================')
console.log(' main() boot-order contract (Phase 10.1)')
console.log('============================================================')

const chain: Array<[string, string]> = [
  ['B1 argv alias normalization', 'BYPASS_ALIASES[arg] ?? arg'],
  ['B2 boot-env applied first', 'applyBootMenuEnv()'],
  ['B3 private config home tightened', 'ensurePrivateConfigHome()'],
  ['B5a Windows PATH-hijack guard', "NoDefaultCurrentDirectoryInExePath = '1'"],
  ['B5b warning handler', 'initializeWarningHandler()'],
  ['B5c exit handler returns the terminal ground', "process.on('exit'"],
  ['B5d SIGINT handler installed', "process.on('SIGINT'"],
]
let prev = -1
let prevName = '(start)'
for (const [name, needle] of chain) {
  const i = mainBody.indexOf(needle)
  check(`${name} present`, i !== -1, needle)
  check(`${name} after ${prevName}`, i > prev, `${i} <= ${prev}`)
  prev = i
  prevName = name
}

check('the early seams are named as one pinned sequence', mainBody.includes('the early seams, in pinned order'))

const sigintIdx = mainBody.indexOf("process.on('SIGINT'")
const sigintBand = mainBody.slice(Math.max(0, sigintIdx - 240), sigintIdx)
check(
  'the SIGINT handler carves out -p/--print (print.ts owns SIGINT there)',
  sigintBand.includes('if (!isPrintModeArgv()) {'),
  sigintBand.slice(-160),
)

const runIdx = mainBody.indexOf('run(')
check('B6 the opening band precedes the commander run()/parse', runIdx > prev, `run@${runIdx} vs last landmark@${prev}`)

const print = readFileSync(join(ROOT, 'src', 'cli', 'print.ts'), 'utf-8')
const rh = print.slice(print.indexOf('export async function runHeadless('))
const stampIdx = rh.indexOf('markSessionNonInteractive(')
const promptIdx = Math.min(
  ...['fetchSystemPromptParts', 'getSystemPrompt('].map(n => {
    const i = rh.indexOf(n)
    return i === -1 ? Number.MAX_SAFE_INTEGER : i
  }),
)
check('B7 runHeadless stamps NON-INTERACTIVE before any system-prompt composition', stampIdx !== -1 && stampIdx < promptIdx, `stamp@${stampIdx} prompt@${promptIdx}`)

{
  const doors = main.split('announceAbandonedLaunch()').length - 1
  check('B8a both abandon doors announce', doors >= 2, `${doors} call site(s)`)
  check(
    'B8b the announcement is an exit hook, not an inline write (restoration-safe)',
    /function announceAbandonedLaunch\(\)[\s\S]{0,400}process\.once\('exit'/.test(main),
  )
  check("B8c a deliberate clean quit stays quiet (code 0 returns before the write)", /process\.once\('exit', code => \{\s*\n\s*if \(code === 0\) return/.test(main))
  check(
    'B8d the one honest line names the refusal and the road to the initiator',
    main.includes('Mercury did not start: a shutdown was initiated during boot (exit ${code}). Boot again with --debug and read the debug log for the initiator.'),
  )
  check('B8e the latch writes once across both doors', main.includes('if (abandonAnnounced) return'))
  check(
    'B8f POISON (the wordless return): each door announces immediately before its abandoning debug line',
    main.includes("announceAbandonedLaunch()\n    logForDebugging('graceful shutdown already initiated; abandoning interactive launch')") &&
      main.includes("announceAbandonedLaunch()\n    logForDebugging('shutdown in progress; abandoning interactive launch')"),
  )
}

console.log('\n============================================================')
if (failures === 0) {
  console.log(' ✅ BOOT ORDER CONTRACT GREEN')
  process.exit(0)
}
console.log(` ❌ ${failures} BOOT ORDER FAILURE(S)`)
process.exit(1)
