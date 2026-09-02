#!/usr/bin/env bun
// ============================================================================
//  scripts/model-floor/prove-model-floor.ts
//  PROOF: the mechanical never-Haiku floor. Enumerates the
//  INPUT SPACE (fable-audit lesson: on a gate primitive, table the inputs) —
//  every haiku spelling × every resolution path ⇒ claude-sonnet-5 on the fork;
//  every non-haiku input byte-identical; bare-stamp passes haiku through
//  unchanged.
//  Run:  ~/.bun/bin/bun run scripts/model-floor/prove-model-floor.ts
// ============================================================================
let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void { console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76)) }
const MK = 'MACRO' as const
const setStamp = (on: boolean) => { if (on) (globalThis as Record<string, unknown>)[MK] = { VERSION: '1.0.0' }; else delete (globalThis as Record<string, unknown>)[MK] }

console.log('============================================================')
console.log(' Never-Haiku model floor — proof')
console.log('============================================================')

const mf = (await import('../../src/utils/model/modelFloor.js')) as typeof import('../../src/utils/model/modelFloor.js')
const ag = (await import('../../src/utils/model/agent.js')) as typeof import('../../src/utils/model/agent.js')
const hr = (await import('../../src/daemon/headlessRun.js')) as typeof import('../../src/daemon/headlessRun.js')


section('isHaikuTier — spelling table (all true)')
const HAIKU_SPELLINGS = [
  'haiku',
  'haiku[1m]',
  'Haiku',
  'HaIkU',
  'claude-haiku-4-5',
  'claude-haiku-4-5-20251001',
  'claude-3-5-haiku-20241022',
  'claude-3-haiku-20240307',
  'us.anthropic.claude-haiku-4-5-20251001-v1:0',
  'eu.anthropic.claude-3-5-haiku-20241022-v1:0',
]
for (const s of HAIKU_SPELLINGS) check(`isHaikuTier('${s}')`, mf.isHaikuTier(s) === true)

section('isHaikuTier — non-haiku table (all false)')
const ALLOWED = [
  'claude-opus-4-8',
  'claude-opus-4-8[1m]',
  'claude-sonnet-5',
  'claude-sonnet-4-6',
  'claude-fable-5',
  'claude-mythos-5',
  'opus',
  'sonnet',
  'sonnet5',
  'fable',
  '',
]
for (const s of ALLOWED) check(`!isHaikuTier('${s}')`, mf.isHaikuTier(s) === false)

section('isHaikuTier — the haiku-SLOT env-pin fold (AGENTVERIFY A1: the alias resolves to the pin VALUE before the floor sees it)')
// Disease shape: ANTHROPIC_DEFAULT_HAIKU_MODEL='fastcheap-gw-v1' — an opaque
// gateway/ARN spelling. parseUserSpecifiedModel('haiku') answers that value,
// so a frontmatter `model: haiku` reached the floor as a string with no
// 'haiku' anywhere and dispatched UN-floored.
process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = 'fastcheap-gw-v1'
check("pinned haiku-slot value is haiku-tier ('fastcheap-gw-v1')", mf.isHaikuTier('fastcheap-gw-v1') === true)
check('pinned value floors to sonnet-5', mf.enforceSubagentModelFloor('fastcheap-gw-v1', 'proof:pin') === mf.NEVER_HAIKU_FALLBACK)
check("agent-def 'haiku' under the pin ⇒ sonnet-5 (the resolution road)", ag.getAgentModel('haiku', 'claude-opus-4-8') === mf.NEVER_HAIKU_FALLBACK)
check("pin value with a [1m] rider still folds", mf.isHaikuTier('fastcheap-gw-v1[1m]') === true)
// The counter-case: a pin whose own string canonicalizes to another
// first-party family is recognizably NOT haiku-tier — an operator may route
// the small slot UP, and flooring lawful strength would rewrite it.
process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = 'my-claude-sonnet-5-gw'
check('sonnet-canonical pin value is NOT haiku-tier', mf.isHaikuTier('my-claude-sonnet-5-gw') === false)
check("agent-def 'haiku' under a sonnet pin keeps the operator spelling", ag.getAgentModel('haiku', 'claude-opus-4-8') === 'my-claude-sonnet-5-gw')
delete process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL
// The small/fast sibling pin (getSmallFastModel's first read) is the same slot.
process.env.ANTHROPIC_SMALL_FAST_MODEL = 'cheap-utility-x'
check("ANTHROPIC_SMALL_FAST_MODEL value is haiku-tier ('cheap-utility-x')", mf.isHaikuTier('cheap-utility-x') === true)
delete process.env.ANTHROPIC_SMALL_FAST_MODEL
check('unpinned: the opaque spellings are nobody-tier again', mf.isHaikuTier('fastcheap-gw-v1') === false && mf.isHaikuTier('cheap-utility-x') === false)

section('enforceSubagentModelFloor — fork ON: haiku ⇒ claude-sonnet-5, else byte-identical')
setStamp(true)
for (const s of HAIKU_SPELLINGS) {
  check(`floor('${s}') ⇒ '${mf.NEVER_HAIKU_FALLBACK}'`, mf.enforceSubagentModelFloor(s, 'proof') === mf.NEVER_HAIKU_FALLBACK)
}
for (const s of ALLOWED) {
  check(`floor('${s}') unchanged`, mf.enforceSubagentModelFloor(s, 'proof') === s)
}
check('fallback constant is claude-sonnet-5', mf.NEVER_HAIKU_FALLBACK === 'claude-sonnet-5')

// the never-Haiku floor holds under ANY stamp (a mis-stamped build cannot
// silently drop the protection).
section('enforceSubagentModelFloor — bare stamp: floor STILL applies (stamp-independence)')
setStamp(false)
for (const s of HAIKU_SPELLINGS.slice(0, 4)) {
  check(`bare-stamp floor('${s}') ⇒ fallback`, mf.enforceSubagentModelFloor(s, 'proof') === mf.NEVER_HAIKU_FALLBACK)
}

section('FloorEvent ring — records origin + blocked + fallback, bounded')
setStamp(true)
const before = mf.recentFloorEvents().length
mf.enforceSubagentModelFloor('haiku', 'proof:ring')
const events = mf.recentFloorEvents()
check('event recorded', events.length === Math.min(before + 1, 20))
const last = events[events.length - 1]!
check('origin captured', last.origin === 'proof:ring')
check('blocked captured', last.blocked === 'haiku')
check('fallback captured', last.fallback === mf.NEVER_HAIKU_FALLBACK)
for (let i = 0; i < 30; i++) mf.enforceSubagentModelFloor('haiku', `proof:cap${i}`)
check('ring bounded at 20', mf.recentFloorEvents().length <= 20)

section('getAgentModel — the resolution paths, floored end-to-end (fork ON)')
setStamp(true)
// path 3: agent-def literal haiku pin (the Explore-def defect class)
check("agent-def 'haiku' ⇒ sonnet-5", ag.getAgentModel('haiku', 'claude-opus-4-8') === mf.NEVER_HAIKU_FALLBACK)
// path 2: tool-specified haiku alias
check("tool-specified 'haiku' ⇒ sonnet-5", ag.getAgentModel(undefined, 'claude-opus-4-8', 'haiku') === mf.NEVER_HAIKU_FALLBACK)
// path 4: inherit from a Haiku main loop (the 'inherit is insufficient' class)
check("'inherit' from haiku parent ⇒ sonnet-5", ag.getAgentModel('inherit', 'claude-haiku-4-5-20251001') === mf.NEVER_HAIKU_FALLBACK)
// non-haiku flows untouched
check("agent-def 'inherit' from opus parent unchanged", ag.getAgentModel('inherit', 'claude-opus-4-8') === 'claude-opus-4-8')
check("tool-specified 'opus' tier-match inherits parent exact", ag.getAgentModel(undefined, 'claude-opus-4-8[1m]', 'opus') === 'claude-opus-4-8[1m]')

section('getAgentModel — bare stamp: floor STILL applies (stamp-independence)')
setStamp(false)
const bareStampResolved = ag.getAgentModel('haiku', 'claude-opus-4-8')
check("bare-stamp agent-def 'haiku' ⇒ sonnet-5 (never Haiku, any stamp)", bareStampResolved === mf.NEVER_HAIKU_FALLBACK, bareStampResolved)

section('buildStreamJsonInvocation — daemon spawn seam floored (fork ON)')
setStamp(true)
const spec = {
  model: 'claude-haiku-4-5-20251001',
  effort: 'high',
  appendSystemPrompt: '',
  role: 'MERCURY_CREW' as const,
  agentName: 'scout',
  agentId: 'scout@default',
  teamName: 'default',
}
const inv = hr.buildStreamJsonInvocation(spec)
const modelFlagIdx = inv.argv.indexOf('--model')
check('--model floored to sonnet-5', inv.argv[modelFlagIdx + 1] === mf.NEVER_HAIKU_FALLBACK)
check('ANTHROPIC_MODEL floored to sonnet-5', inv.env.ANTHROPIC_MODEL === mf.NEVER_HAIKU_FALLBACK)
const okSpec = { ...spec, model: 'claude-opus-4-8[1m]' }
const okInv = hr.buildStreamJsonInvocation(okSpec)
check('non-haiku spec unchanged', okInv.argv[okInv.argv.indexOf('--model') + 1] === 'claude-opus-4-8[1m]' && okInv.env.ANTHROPIC_MODEL === 'claude-opus-4-8[1m]')

setStamp(false)

console.log('\n' + '='.repeat(60))
if (failures > 0) { console.log(` FAIL — ${failures} check(s) failed`); process.exit(1) }
console.log(' ALL PASS')
