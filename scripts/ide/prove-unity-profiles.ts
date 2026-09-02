#!/usr/bin/env bun
// ============================================================================
//  scripts/ide/prove-unity-profiles.ts
//  PROOF: the unity headless launch-profile source (MERCURY_UNITY opt-in)
//  + the operator-run refusal contract.
//
//   §1  opt-in polarity: off ⇒ ZERO unity profiles even inside a Unity
//       project; armed outside a project ⇒ zero too.
//   §2  armed + project ⇒ exactly EditMode test · PlayMode test · build;
//       the documented flag shapes hold: tests mirror the doc example
//       (-runTests -batchmode -projectPath -testResults -testPlatform) and
//       NEVER carry -quit (the documented constraint); build carries
//       -quit + -executeMethod with the project-owned placeholder and no
//       -runTests. Every profile carries the license disclaimer note; ids
//       are content-stable across discoveries.
//   §3  results-XML convention: .mercury/unity-test-results/<mode>.xml.
//   §4  the refusal contract: operator-run — the exact command + the
//       disclaimer, outcome no-change; the test refusal names where the
//       results XML lands. Discovery + refusal EXECUTE NOTHING.
//
//  cpu-pure: scratch trees only.
//  Run:  ~/.bun/bin/bun run scripts/ide/prove-unity-profiles.ts
// ============================================================================
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

console.log('============================================================')
console.log(' unity headless launch profiles (MERCURY_UNITY) — proof')
console.log('============================================================')

const { discoverLaunchProfiles } = await import('../../src/services/ide/launchProfiles.js')
const { UNITY_LICENSE_DISCLAIMER, unityTestResultsPath } = await import(
  '../../src/services/ide/unityProject.js'
)
const { unityHeadlessRefusal } = await import('../../src/tools/LaunchTool/LaunchTool.js')

const savedEnv = { ...process.env }
function restore(): void {
  for (const k of Object.keys(process.env)) {
    if (!(k in savedEnv)) delete process.env[k]
  }
  Object.assign(process.env, savedEnv)
}

const scratch = mkdtempSync(path.join(tmpdir(), 'unity-profiles-'))
const proj = path.join(scratch, 'Game')
mkdirSync(path.join(proj, 'Assets'), { recursive: true })
mkdirSync(path.join(proj, 'ProjectSettings'), { recursive: true })
writeFileSync(
  path.join(proj, 'ProjectSettings', 'ProjectVersion.txt'),
  'm_EditorVersion: 6000.3.4f1\n',
)

section('§1 · opt-in polarity')
{
  restore()
  delete process.env.MERCURY_UNITY
  const off = await discoverLaunchProfiles(proj)
  check(
    'off: zero unity profiles inside a Unity project',
    off.profiles.every(p => p.source !== 'unity'),
  )
  process.env.MERCURY_UNITY = '1'
  const outside = await discoverLaunchProfiles(scratch)
  check('armed outside a project: zero unity profiles', outside.profiles.every(p => p.source !== 'unity'))
}

section('§2 · the three shapes (doc-law pinned)')
{
  restore()
  process.env.MERCURY_UNITY = '1'
  const d = await discoverLaunchProfiles(proj)
  const unity = d.profiles.filter(p => p.source === 'unity')
  check('exactly three unity profiles (EditMode · PlayMode · build)', unity.length === 3)
  const tests = unity.filter(p => p.kind === 'test')
  const build = unity.find(p => p.kind === 'build')
  check('two test profiles + one build profile', tests.length === 2 && build !== undefined)
  for (const t of tests) {
    const args = t.unityHeadless?.args ?? []
    const mode = args[args.indexOf('-testPlatform') + 1]
    check(
      `test (${mode}): the documented example shape, in order`,
      args[0] === '-runTests' &&
        args.includes('-batchmode') &&
        args[args.indexOf('-projectPath') + 1] === proj &&
        args.includes('-testResults') &&
        (mode === 'EditMode' || mode === 'PlayMode'),
    )
    check(
      `test (${mode}): NEVER -quit (the documented constraint)`,
      !args.includes('-quit'),
    )
  }
  const buildArgs = build?.unityHeadless?.args ?? []
  check(
    'build: -batchmode -nographics -quit -executeMethod, no -runTests',
    buildArgs.includes('-quit') &&
      buildArgs.includes('-nographics') &&
      buildArgs.includes('-executeMethod') &&
      !buildArgs.includes('-runTests'),
  )
  check(
    'build: the method placeholder is the PROJECT-owned teaching spelling',
    buildArgs[buildArgs.indexOf('-executeMethod') + 1] === '<Your.Editor.BuildMethod>',
  )
  check(
    'every profile carries the license disclaimer note',
    unity.every(p => p.unityHeadless?.note === UNITY_LICENSE_DISCLAIMER),
  )
  check(
    'no editor located ⇒ the commandLine spells the placeholder honestly',
    unity.every(
      p =>
        p.unityHeadless !== undefined &&
        (p.unityHeadless.editorPath !== undefined ||
          p.unityHeadless.commandLine.startsWith('<unity-editor>')),
    ),
  )
  const d2 = await discoverLaunchProfiles(proj)
  const ids = (arr: typeof d.profiles): string => arr.filter(p => p.source === 'unity').map(p => p.id).sort().join(',')
  check('ids content-stable across discoveries', ids(d.profiles) === ids(d2.profiles))
}

section('§3 · results-XML convention')
{
  check(
    'unityTestResultsPath: .mercury/unity-test-results/<mode>.xml',
    unityTestResultsPath('/r', 'EditMode') === path.join('/r', '.mercury', 'unity-test-results', 'editmode.xml') &&
      unityTestResultsPath('/r', 'PlayMode') === path.join('/r', '.mercury', 'unity-test-results', 'playmode.xml'),
  )
}

section('§4 · the operator-run refusal contract')
{
  restore()
  process.env.MERCURY_UNITY = '1'
  const d = await discoverLaunchProfiles(proj)
  const test = d.profiles.find(p => p.source === 'unity' && p.kind === 'test')
  const build = d.profiles.find(p => p.source === 'unity' && p.kind === 'build')
  const nonUnity = d.profiles.find(p => p.source !== 'unity')
  const tRef = test ? unityHeadlessRefusal(test) : null
  check(
    'test refusal: operator-run + the exact command + disclaimer + the results-XML line, no-change',
    tRef !== null &&
      tRef.outcome === 'no-change' &&
      tRef.result.includes('run it yourself') &&
      tRef.result.includes(test?.unityHeadless?.commandLine ?? '∅') &&
      tRef.result.includes(UNITY_LICENSE_DISCLAIMER) &&
      tRef.result.includes('results XML'),
  )
  const bRef = build ? unityHeadlessRefusal(build) : null
  check(
    'build refusal: same contract, no results-XML line',
    bRef !== null && bRef.outcome === 'no-change' && !bRef.result.includes('results XML'),
  )
  check(
    'non-unity profiles refuse nothing here',
    nonUnity === undefined || unityHeadlessRefusal(nonUnity) === null,
  )
}

restore()
rmSync(scratch, { recursive: true, force: true })

console.log('\n============================================================')
if (failures > 0) {
  console.log(` RESULT: ${failures} check(s) FAILED`)
  process.exit(1)
}
console.log(' RESULT: all checks passed')
