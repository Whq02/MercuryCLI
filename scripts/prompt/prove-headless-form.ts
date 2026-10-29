import { proofHome } from '../lib/hermetic.ts'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
for (const key of ['MERCURY_BARE', 'MERCURY_PROMPT_LAYERS', 'MERCURY_PROMPT_REPLACE_FILE']) delete process.env[key]
const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setOriginalCwd(proofHome)
bootstrap.setProjectRoot(proofHome)
bootstrap.setCwdState(proofHome)
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const posture = await import('../../src/utils/cockpit/runtimePosture.ts')
const { getSystemPrompt } = await import('../../src/constants/prompts.ts')
const { clearSystemPromptSections } = await import('../../src/constants/systemPromptSections.ts')
const { MERCURY_CONSTITUTION, MERCURY_HEADLESS_CONSTITUTION } = await import('../../src/prompt/mercuryContract.ts')
assert.equal(createHash('sha256').update(MERCURY_HEADLESS_CONSTITUTION).digest('hex'), '9595496ce4654ac46ec5f168ca7746ccd2ee42fc26e4f3d64a8e4df06d00b937')
const sameTurn = [
  'Act on a tool result in the turn it arrives; never spend a turn restating a result or announcing the next step.',
  "An edit and the check that verifies it ride the same turn: Mercury runs one message's tool calls in order, so the check sees the edit's effect; a read needs a separate turn only when the next step needs its contents.",
]
for (const law of [MERCURY_CONSTITUTION, MERCURY_HEADLESS_CONSTITUTION]) {
  const engineering = law.slice(law.indexOf('## Engineering'), law.indexOf('## Communication'))
  for (const sentence of sameTurn) assert.ok(engineering.includes(sentence), sentence)
}
const { staticCompositionChanged } = await import('../../src/prompt/recordedComposition.ts')
assert.equal(staticCompositionChanged([{ name: 'static-composition', value: JSON.stringify(['head', 'constitution', MERCURY_CONSTITUTION]), key: null }]), true, 'a pre-mode-selection record must restore its whole old prompt instead of composing a new headless law')
posture.markSessionNonInteractive('flow')
bootstrap.setAskChannel('none')
bootstrap.setSessionKind('headless')
const headless = await getSystemPrompt([], 'glm-5.3', [], 'flow')
assert.notEqual(headless[1], MERCURY_CONSTITUTION, 'a run without a host gets its own work contract')
assert.ok(Buffer.byteLength(headless[1]!) < Buffer.byteLength(MERCURY_CONSTITUTION))
for (const rule of ['authoris', 'destructive', 'stop', 'pause', 'resume', 'denial', 'permission', 'evidence', 'verify', 'scope', 'delegat', 'failure', 'assumption']) {
  assert.ok(headless[1]!.toLowerCase().includes(rule), `the headless work contract retains ${rule}`)
}
assert.ok(!headless[1]!.includes('Read the room.'))
assert.ok(!headless.join('\n').includes('Write down important information from tool results'), 'the answer is not a second tool transcript')
assert.ok(headless[1]!.includes('Provide the result, the checks and any unresolved blockers in direct, concise, plain language.'))
const sections = [...bootstrap.getSystemPromptSectionCache()].map(([name, entry]) => ({ name, ...entry }))
assert.equal(staticCompositionChanged(sections), false, 'the recorded headless composition is current')
posture.markSessionPermissionMode('sovereign')
assert.deepEqual(await getSystemPrompt([], 'glm-5.3', [], 'sovereign'), headless, 'permission changes do not rewrite the prefix')
bootstrap.setAskChannel('sdk')
assert.deepEqual(await getSystemPrompt([], 'glm-5.3', [], 'sovereign'), headless, 'a later host does not rewrite the bound work contract')
clearSystemPromptSections()
posture.resetRuntimePostureForTest()
posture.markSessionNonInteractive('flow')
bootstrap.setSessionKind('oculus')
const hosted = await getSystemPrompt([], 'glm-5.3', [], 'flow')
assert.equal(hosted[1], MERCURY_CONSTITUTION, 'the operator-facing prompt stays verbatim')
assert.equal(staticCompositionChanged(sections), false, 'restoring a headless prefix keeps its recorded mode')
console.log(JSON.stringify({ stockBytes: Buffer.byteLength(MERCURY_CONSTITUTION), headlessBytes: Buffer.byteLength(headless[1]!), saved: Buffer.byteLength(MERCURY_CONSTITUTION) - Buffer.byteLength(headless[1]!) }))
console.log('PASS headless work rules, hosted wording and byte-stable mode selection')
