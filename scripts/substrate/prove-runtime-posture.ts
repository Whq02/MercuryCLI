#!/usr/bin/env bun

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const saved = {
  posture: process.env.MERCURY_RUNTIME_POSTURE,
  kill: process.env.MERCURY_KILL,
  risk: process.env.MERCURY_MCP_MAX_RISK,
}
delete process.env.MERCURY_RUNTIME_POSTURE
delete process.env.MERCURY_KILL
delete process.env.MERCURY_MCP_MAX_RISK

const {
  getRuntimePostureSection,
  getRuntimePostureDoctrineLine,
  markSessionNonInteractive,
  resetRuntimePostureForTest,
  runtimePostureEnabled,
} = await import('../../src/utils/cockpit/runtimePosture.js')
const { buildSubagentMercurySections } = await import('../../src/constants/subagentDoctrine.js')

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

const ROOT = join(import.meta.dir, '..', '..')
const src = (p: string): string => readFileSync(join(ROOT, p), 'utf8')

console.log('============================================================')
console.log(' runtime posture (init-path self-knowledge) — proof')
console.log('============================================================')

section('gate — default-ON, =0 byte-identical absence')
{
  check('default ⇒ enabled', runtimePostureEnabled() === true)
  process.env.MERCURY_RUNTIME_POSTURE = '0'
  resetRuntimePostureForTest()
  check('=0 ⇒ disabled', runtimePostureEnabled() === false)
  check('=0 ⇒ section null (absent from the prompt)', getRuntimePostureSection() === null)
  check('=0 ⇒ doctrine line null', getRuntimePostureDoctrineLine() === null)
  const sections = buildSubagentMercurySections({ agentDefinition: { agentType: 'mercury-crew' } })
  check(
    '=0 ⇒ no posture text in the subagent doctrine',
    sections.every(s => !s.includes('Runtime posture:')),
  )
  delete process.env.MERCURY_RUNTIME_POSTURE
  resetRuntimePostureForTest()
}

section('interactive posture (the default) — nothing armed, nothing to say')
{
  const s = getRuntimePostureSection()
  check('an interactive session with no kill and no MCP cap carries no posture block (the ask itself, the kill gate\'s refusal and the policy\'s refusal carry those facts when they bite)', s === null, s ?? '')
  check('MEMOIZED — second call returns the identical value', getRuntimePostureSection() === s)
}

section('headless posture (the daemon-child / run truth)')
{
  const { setAskChannel } = await import('../../src/bootstrap/state.ts')
  resetRuntimePostureForTest()
  setAskChannel('none')
  markSessionNonInteractive('implement')
  const text = getRuntimePostureSection() ?? ''
  check('headless semantics stated', /Session: non-interactive \(mercury run\)/.test(text))
  check('deny-is-policy instruction present', /denied automatically/.test(text) && /A denial is policy, not tool failure/.test(text))
  check('without a host the posture says no question can reach the operator', /no host answers an ask/.test(text) && /no question can reach the operator/.test(text))
  resetRuntimePostureForTest()
  setAskChannel('sdk')
  markSessionNonInteractive('implement')
  const channelled = getRuntimePostureSection() ?? ''
  check('with a host the posture says asks reach the connected host', /with a host that holds the asks/.test(channelled) && /answers allow or deny/.test(channelled) && !/denied automatically/.test(channelled))
  setAskChannel('operator')
  resetRuntimePostureForTest()
  markSessionNonInteractive('implement')
  check('the boot permission mode is not restated on a run without a host (a refusal names the rule and the mode)', !/Permission mode for this run/.test(text))
  check('the runner seat with a host keeps its own words, the mode among them', /Permission mode for this run: implement/.test(channelled))
  const line = getRuntimePostureDoctrineLine() ?? ''
  check('doctrine line carries the headless deny semantics', /this process is headless: an unanswerable permission ask is denied automatically/.test(line))
  check('doctrine line carries lease semantics', /file-lease denial/.test(line))
}

section('oculus posture (a screen belongs to the session) — one line in plain words; the headless half untouched')
{
  const { setAskChannel, setSessionKind } = await import('../../src/bootstrap/state.ts')
  resetRuntimePostureForTest()
  setAskChannel('sdk')
  setSessionKind('oculus')
  markSessionNonInteractive('implement')
  const text = getRuntimePostureSection() ?? ''
  check('an oculus seat says a screen belongs to this session and the operator is on it', /Session: oculus \(a screen belongs to this session\): the operator is on the screen/.test(text), text)
  check('…asks travel to the screen and wait without expiry; a slow answer is not "nobody is here"', /ask them as you normally would/.test(text) && /nothing expires it/.test(text) && /a slow answer is not "nobody is here"/.test(text))
  check('…a denial is policy, not tool failure', /A denial is policy, not tool failure/.test(text))
  check('…never the headless words', !/non-interactive/.test(text) && !/no human is at a prompt/.test(text) && !/denied automatically/.test(text) && !/ends the run as blocked/.test(text))
  check('…the boot mode rides it as on any hosted seat', /Permission mode for this run: implement/.test(text))
  check("an oculus parent's doctrine line says the screen holds the session", /^Runtime posture: this process is an oculus session: a screen belongs to it/.test(getRuntimePostureDoctrineLine() ?? '') && /file-lease denial/.test(getRuntimePostureDoctrineLine() ?? ''))
  setSessionKind('headless')
  resetRuntimePostureForTest()
  markSessionNonInteractive('implement')
  check('a headless seat under the same host keeps its own words', /Session: non-interactive \(mercury runner\) with a host that holds the asks/.test(getRuntimePostureSection() ?? ''))
  check("a headless parent's doctrine line keeps its own words", /^Runtime posture: this process is headless: an unanswerable permission ask is denied automatically/.test(getRuntimePostureDoctrineLine() ?? ''))
  setSessionKind('oculus')
  setAskChannel('none')
  resetRuntimePostureForTest()
  markSessionNonInteractive('implement')
  check('an oculus stamp with no host composes the bare headless line (a screen needs a door)', /Session: non-interactive \(mercury run\)/.test(getRuntimePostureSection() ?? ''))
  setSessionKind('headless')
  setAskChannel('operator')
  resetRuntimePostureForTest()
}

section('boot-state capture — kills + MCP cap render when armed at boot')
{
  const { killCapability, restoreCapability } = await import(
    '../../src/utils/permissions/capabilityGate.js'
  )
  resetRuntimePostureForTest()
  process.env.MERCURY_MCP_MAX_RISK = 'low'
  killCapability('*', 'WebFetch')
  const text = getRuntimePostureSection() ?? ''
  check('an armed kill or a cap brings the block back, titled as a posture block', text.startsWith('# Runtime posture (this process, at boot)'))
  check('armed kill named, labeled at boot, the live surface named', /kills armed at boot: .*WebFetch/.test(text) && /Live state: \/kill/.test(text))
  check('no agent-model floor is stated (nothing substitutes a chosen model)', !/floor/i.test(text) && !/Haiku/.test(text))
  check('nothing non-default is restated: no session line, no permissive line, no lease line', !/Session:/.test(text) && !/permissive/.test(text) && !/File leases/.test(text))
  check('kill absoluteness stated (bypass cannot override)', /bypass, overrides a kill/.test(text) || /no mode, including bypass/.test(text))
  check('MCP cap reflected', /MCP tool-risk policy: (?!permissive)/.test(text))
  restoreCapability('*', 'WebFetch')
  delete process.env.MERCURY_MCP_MAX_RISK
  resetRuntimePostureForTest()
}

section('composition into the subagent doctrine (both chokepoints share the seam)')
{
  resetRuntimePostureForTest()
  const interactiveChild = buildSubagentMercurySections({ agentDefinition: { agentType: 'mercury-crew' } })
  check(
    'an interactive parent\'s child carries no posture line (its seat contract says a denied tool is a real denial; a lease refusal names the holder)',
    interactiveChild.every(s => !s.startsWith('Runtime posture:')),
  )
  const { setAskChannel } = await import('../../src/bootstrap/state.ts')
  setAskChannel('none')
  markSessionNonInteractive('default')
  const sections = buildSubagentMercurySections({ agentDefinition: { agentType: 'mercury-crew' } })
  check(
    'a headless parent\'s child carries the headless posture line',
    sections.some(s => s.startsWith('Runtime posture: this process is headless')),
  )
  const exempt = buildSubagentMercurySections({ agentDefinition: { agentType: 'Explore' } })
  check(
    'fable-exempt agents still get the posture (it is scope-neutral)',
    exempt.some(s => s.startsWith('Runtime posture:')),
  )
  const { setSessionKind } = await import('../../src/bootstrap/state.ts')
  resetRuntimePostureForTest()
  setAskChannel('sdk')
  setSessionKind('oculus')
  markSessionNonInteractive('default')
  const oculusChild = buildSubagentMercurySections({ agentDefinition: { agentType: 'mercury-crew' } })
  check(
    "an oculus parent's child carries the oculus posture line, never the headless one",
    oculusChild.some(s => s.startsWith('Runtime posture: this process is an oculus session')) && oculusChild.every(s => !s.startsWith('Runtime posture: this process is headless')),
  )
  setSessionKind('headless')
  setAskChannel('operator')
  resetRuntimePostureForTest()
}

section('wiring (structural) — prompts.ts section + print-entry marker')
{
  const prompts = src('src/constants/prompts.ts')
  check(
    "prompts.ts registers the 'runtime_posture' dynamic section",
    /systemPromptSection\('runtime_posture', \(\) => getRuntimePostureSection\(\)\)/.test(prompts),
  )
  const print = src('src/cli/run.ts')
  check(
    'runHeadless stamps non-interactive with the resolved boot mode',
    /markSessionNonInteractive\(getAppState\(\)\.toolPermissionContext\?\.mode\)/.test(print),
  )
}

for (const [k, v] of [
  ['MERCURY_RUNTIME_POSTURE', saved.posture],
  ['MERCURY_KILL', saved.kill],
  ['MERCURY_MCP_MAX_RISK', saved.risk],
] as const) {
  if (v === undefined) delete process.env[k]
  else process.env[k] = v
}

console.log('\n============================================================')
if (failures === 0) {
  console.log(' ✅ PROOF PASSES — every init path states its runtime posture')
} else {
  console.log(` ❌ PROOF FAILED — ${failures} check(s) failed`)
  process.exit(1)
}
