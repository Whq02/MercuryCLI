#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
// @ts-ignore -- untyped .mjs module
import { cmdLauncher, parseEnginesNode } from '../release/launcherTemplates.mjs'

let failures = 0
const check = (name: string, cond: boolean, detail?: string): void => {
  if (cond) console.log(`  [PASS] ${name}`)
  else {
    failures++
    console.log(`  [FAIL] ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const pkg = JSON.parse(readFileSync(join(import.meta.dir, '..', '..', 'package.json'), 'utf8')) as { engines?: { node?: string } }
const cmd: string = cmdLauncher(parseEnginesNode(pkg.engines?.node))
const lines = cmd.split('\r\n')
const probeLine = lines.find(l => l.includes('"%NODEBIN%" -e') && l.includes('process.stdin.isTTY')) ?? ''
const argvAt = probeLine.lastIndexOf(' -- %*')
const stdoutAt = probeLine.indexOf('>"%MERCURY_PROBE_OUT%"')
const stderrAt = probeLine.indexOf('2>nul')

console.log('\n── the probe line binds its capture before the user argv ──')
check('the probe line exists on the resolved runtime', probeLine !== '', cmd.slice(0, 200))
check('the user argv is the LAST thing on the probe line, behind the -- terminator', argvAt !== -1 && probeLine.endsWith(' -- %*'), probeLine)
check('the stdout capture is bound BEFORE the argv (a line break in argv ends a cmd line; what follows it is gone)', stdoutAt !== -1 && stdoutAt < argvAt, probeLine)
check('the stderr sink is bound BEFORE the argv for the same reason', stderrAt !== -1 && stderrAt < argvAt, probeLine)
check('the probe JS still precedes the capture (one node start, the same program)', probeLine.indexOf('process.stdin.isTTY') < stdoutAt, probeLine)

console.log('\n── the cmd.exe line cut, modelled over the template text ──')
const twoLinePrompt = 'run --format rows "Line one of this prompt says: reply with the word ALPHA.\nLine two of this prompt says: also reply with the word BRAVO."'
const expanded = probeLine.replace('%*', twoLinePrompt)
const survivor = expanded.split('\n')[0] ?? ''
check('after the cut at the line break the surviving probe command still carries its stdout capture', survivor.includes('>"%MERCURY_PROBE_OUT%"'), survivor)
check('after the cut the surviving probe command still carries its stderr sink', survivor.includes('2>nul'), survivor)
check('after the cut the probe still reads its argv behind the -- terminator', survivor.includes(' -- run '), survivor)

console.log('\n── the boot line is unchanged: the argv is forwarded plainly, nothing to lose at a cut ──')
check('the boot line forwards argv plainly', lines.includes('"%NODEBIN%" "%DIR%mercury.mjs" %*'))
check('exactly one probe line', lines.filter(l => l.includes('"%NODEBIN%" -e') && l.includes('process.stdin.isTTY')).length === 1)

if (failures > 0) {
  console.log(`\nRED: ${failures} check(s) failed — prove-launcher-probe-redirect`)
  process.exit(1)
}
console.log('\nGREEN: the probe capture is bound before the argv — prove-launcher-probe-redirect')
process.exit(0)
