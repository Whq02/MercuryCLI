#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { execSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_VERIFY_EVIDENCE = '1'

const {
  workspaceVerifiable,
  classifyVerifySegment,
  classifyVerificationCommand,
  markMutation,
  observeCompletedToolCall,
  recordShellCommandOutcome,
  verificationSummary,
  _resetVerificationStateForTesting,
} = await import('../../src/utils/verification/verificationState.ts')
const { _resetDeclaredGatesForTesting } = await import('../../src/utils/verification/projectGates.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function gitInit(dir: string): void {
  execSync('git init -q && git add -A && git -c user.email=t@t -c user.name=t commit -qm init --allow-empty', { cwd: dir, stdio: 'pipe' })
}

console.log('='.repeat(60))
console.log(' project gates — SM-A registry contract')
console.log('='.repeat(60))

{
  const ws = mkdtempSync(join(tmpdir(), 'pg-godot-'))
  writeFileSync(join(ws, 'project.godot'), '[application]\nconfig/name="Field"\n')
  mkdirSync(join(ws, 'tests'))
  for (let i = 1; i <= 7; i++) writeFileSync(join(ws, 'tests', `gate_${i}.gd`), 'extends SceneTree\n')
  check('(1a) a project.godot workspace is verifiable', workspaceVerifiable(ws) === true)
  const scene = classifyVerifySegment('godot --headless --script tests/gate_1.gd')
  check('(1b) headless scene gate classifies', scene !== null && scene.scope === 'test', JSON.stringify(scene))
  const gut = classifyVerifySegment('godot4 --headless -s addons/gut/gut_cmdln.gd')
  check('(1c) gut runner classifies', gut !== null && gut.scope === 'test', JSON.stringify(gut))
  const parse = classifyVerifySegment('godot --check-only --script game.gd')
  check('(1d) parse check classifies as check', parse !== null && parse.scope === 'check', JSON.stringify(parse))
  check('(1e) bare godot launch is NOT a verify', classifyVerifySegment('godot --headless') === null)
  check("(1f) a verify word inside quotes still mints nothing", classifyVerificationCommand('echo "godot --headless --script x.gd"') === null)
}

{
  const ws = mkdtempSync(join(tmpdir(), 'pg-declared-'))
  check('(2a) empty workspace not verifiable', workspaceVerifiable(ws) === false)
  mkdirSync(join(ws, '.mercury'))
  writeFileSync(join(ws, '.mercury', 'gates.json'), JSON.stringify({
    schema: 1,
    gates: [
      { id: 'scene-gates', argv: ['run_gates.sh'], scope: 'test', coverage: 'the seven scene gates' },
      { id: 'father-soak', argv: ['soak_check.py'], scope: 'check', minRuns: 3, match: 'python3? .*soak' },
    ],
  }))
  _resetDeclaredGatesForTesting()
  markMutation(undefined, [join(ws, '.mercury', 'gates.json')], ws)
  check('(2b) a declared-gates workspace is verifiable', workspaceVerifiable(ws) === true)
  const byArgv = classifyVerificationCommand('bash run_gates.sh', ws)
  check('(2c) declared argv classifies with its gateId', byArgv !== null && byArgv.gateId === 'scene-gates' && byArgv.scope === 'test', JSON.stringify(byArgv))
  const byMatch = classifyVerificationCommand('python3 tools/soak_check.py --all', ws)
  check('(2d) declared match-regex classifies', byMatch !== null && byMatch.gateId === 'father-soak', JSON.stringify(byMatch))
  check('(2e) an undeclared command still classifies as nothing', classifyVerificationCommand('bash run_everything.sh', ws) === null)
  const noCwd = classifyVerificationCommand('bash run_gates.sh')
  check('(2f) declared identity is cwd-scoped (no cwd ⇒ no gateId)', noCwd === null || noCwd.gateId === undefined, JSON.stringify(noCwd))
}

{
  const ws = mkdtempSync(join(tmpdir(), 'pg-negcache-'))
  check('(3a) bare workspace reads not-verifiable (negative cached)', workspaceVerifiable(ws) === false)
  writeFileSync(join(ws, 'package.json'), JSON.stringify({ scripts: { test: 'node t.js' } }))
  markMutation(undefined, [join(ws, 'package.json')], ws)
  check('(3b) creating a real gate + observed mutation flips the verdict IMMEDIATELY', workspaceVerifiable(ws) === true)
}

{
  const ws = mkdtempSync(join(tmpdir(), 'pg-soak-'))
  gitInit(ws)
  mkdirSync(join(ws, '.mercury'))
  writeFileSync(join(ws, '.mercury', 'gates.json'), JSON.stringify({
    schema: 1,
    gates: [{ id: 'father-soak', argv: ['soak_check.py'], scope: 'check', minRuns: 3 }],
  }))
  _resetDeclaredGatesForTesting()
  _resetVerificationStateForTesting()
  markMutation(undefined, [join(ws, 'src.txt')], ws)
  recordShellCommandOutcome('python3 soak_check.py', 0, ws)
  const one = verificationSummary(ws)
  check('(4a) ONE green run of a minRuns:3 gate is NOT verified', one.state !== 'verified', `state=${one.state} detail=${one.detail}`)
  check('(4b) the detail carries the honest soak count', /soak 1\/3/.test(one.detail), one.detail)
  recordShellCommandOutcome('python3 soak_check.py', 0, ws)
  recordShellCommandOutcome('python3 soak_check.py', 0, ws)
  const three = verificationSummary(ws)
  check('(4c) THREE green runs satisfy the soak floor', three.state === 'verified', `state=${three.state} detail=${three.detail}`)
  recordShellCommandOutcome('python3 soak_check.py', 1, ws)
  const red = verificationSummary(ws)
  check('(4d) a red run after the soak reads failed (never sticky-verified)', red.state === 'failed', `state=${red.state}`)
}

{
  const ws = mkdtempSync(join(tmpdir(), 'pg-lifecycle-'))
  gitInit(ws)
  writeFileSync(join(ws, 'package.json'), JSON.stringify({ scripts: { test: 'node t.js' } }))
  _resetVerificationStateForTesting()
  markMutation(undefined, [join(ws, 'src.txt')], ws)
  observeCompletedToolCall('Bash', { command: 'npm test' }, true, ws, undefined, 'launch')
  const afterLaunch = verificationSummary(ws)
  check("(5a) a background launch mints NO evidence (state stays non-verified)", afterLaunch.state !== 'verified', `state=${afterLaunch.state}`)
  recordShellCommandOutcome('npm test', 1, ws)
  const afterRed = verificationSummary(ws)
  check('(5b) the terminal transition mints the REAL outcome (red)', afterRed.state === 'failed', `state=${afterRed.state}`)
  recordShellCommandOutcome('npm test', 0, ws)
  const afterGreen = verificationSummary(ws)
  check('(5c) a green terminal transition mints verified', afterGreen.state === 'verified', `state=${afterGreen.state}`)
  _resetVerificationStateForTesting()
  markMutation(undefined, [join(ws, 'src.txt')], ws)
  observeCompletedToolCall('Bash', { command: 'npm test' }, true, ws)
  check('(5d) an omitted lifecycle still mints (foreground compat unchanged)', verificationSummary(ws).state === 'verified')
}

{
  const { readFileSync } = await import('node:fs')
  const { join: j } = await import('node:path')
  const src = readFileSync(j(import.meta.dir, '..', '..', 'src', 'utils', 'verification', 'verificationState.ts'), 'utf8')
  check('(6a) no bare-git spawn survives (execFile/execFileSync always take gitExe())', !/execFile(?:Sync)?\(\s*'git'/.test(src))
  check('(6b) the resolved spelling is present at both twins', src.split('execFileSync(gitExe(),').length - 1 === 4 && src.includes('execFile(gitExe(), args'))
  const classifier = src.slice(src.indexOf('export function classifyVerifySegment('), src.indexOf('\n}\n', src.indexOf('export function classifyVerifySegment(')))
  check('(6c) classifyVerifySegment mints NO regex per call (the static trio is hoisted)', !classifier.includes('new RegExp') && src.includes('const NPM_VERB_RE') && src.includes('const MAKE_VERB_RE') && src.includes('const JUST_VERB_RE'))
}

console.log('='.repeat(60))
console.log(failures === 0 ? ' ALL PROJECT-GATE PROOFS PASS' : ` ${failures} PROOF(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
