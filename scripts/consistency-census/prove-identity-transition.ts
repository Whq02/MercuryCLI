#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'unison-w1-config-'))
process.env.MERCURY_HOME = mkdtempSync(join(tmpdir(), 'unison-w1-home-'))
process.env.ANTHROPIC_API_KEY = 'fixture-key'
delete process.env.ANTHROPIC_BASE_URL

const { enableConfigs } = await import('../../src/platform/settings/config.ts')
enableConfigs()
const bootstrap = await import('../../src/boot/process-state/processState.ts')
const projDir = mkdtempSync(join(tmpdir(), 'unison-w1-proj-'))
bootstrap.setOriginalCwd(projDir)
process.chdir(projDir)

const { getSystemPrompt } = await import('../../src/engine/system-prompt/defaultSystemPrompt.ts')
const { clearSystemPromptSections } = await import(
  '../../src/engine/system-prompt/systemPromptSections.ts'
)

const MODEL_A = 'claude-opus-5'
const MODEL_B = 'claude-sonnet-5'

let failed = 0
function check(label: string, cond: boolean, detail = '', hint = ''): void {
  if (!cond) failed++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}${!cond && hint ? ' — ' + hint : ''}`)
}
const lineOf = (blocks: string[]): string =>
  blocks.join('\n\n').match(/the model you run through Mercury is[^\n]*/)?.[0] ?? '(no identity line)'
const namesModel = (blocks: string[]): boolean => blocks.join('\n\n').includes(MODEL_A) || blocks.join('\n\n').includes(MODEL_B)
const cache = bootstrap.getSystemPromptSectionCache()

const promptA = await getSystemPrompt([], MODEL_A)
check('§A no env line names an engine, and no block names the model id', lineOf(promptA) === '(no identity line)' && !namesModel(promptA), '', 'getSystemPrompt in src/engine/system-prompt/defaultSystemPrompt.ts must not put the engine line or the model id into any system prompt block')
const entryA = cache.get('env_info_simple')
check('§A env_info_simple entry keyed on the model', entryA?.key?.includes(MODEL_A) === true, '', 'the env_info_simple section cache entry must be keyed on the model passed to getSystemPrompt (src/engine/system-prompt/defaultSystemPrompt.ts, src/engine/system-prompt/systemPromptSections.ts)')

const promptB = await getSystemPrompt([], MODEL_B)
const lineB = lineOf(promptB)
check('§B post-switch: still no engine line and no model id (UN-05: the APPLIED model is a fact of the seat reference)', lineB === '(no identity line)' && !namesModel(promptB), lineB, 'getSystemPrompt in src/engine/system-prompt/defaultSystemPrompt.ts must not name the engine or the model id after a model switch')
const entryB = cache.get('env_info_simple')
check('§B entry rekeyed to the applied model', entryB?.key?.includes(MODEL_B) === true, '', 'the env_info_simple entry must be rekeyed when the model changes (src/engine/system-prompt/defaultSystemPrompt.ts, src/engine/system-prompt/systemPromptSections.ts)')
check('§B frc entry keyed on the applied model too', cache.get('frc')?.key === MODEL_B, '', 'the frc section must be keyed on the applied model (src/engine/system-prompt/defaultSystemPrompt.ts)')

const promptB2 = await getSystemPrompt([], MODEL_B)
check('§C stable recomposition is byte-identical', JSON.stringify(promptB2) === JSON.stringify(promptB), '', 'recomposing getSystemPrompt for the same model must return identical blocks (src/engine/system-prompt/defaultSystemPrompt.ts)')
check('§C zero recompute on a stable turn (entry object held)', cache.get('env_info_simple') === entryB, '', 'a stable recomposition must reuse the cached section entry, not recompute it (src/engine/system-prompt/systemPromptSections.ts)')

await getSystemPrompt([], MODEL_B)
check('§D no-op composition holds every keyed entry', cache.get('env_info_simple') === entryB && cache.get('frc')?.key === MODEL_B, '', 'a no-op composition must keep every keyed section entry (src/engine/system-prompt/systemPromptSections.ts)')

const promptA2 = await getSystemPrompt([], MODEL_A)
const changed: number[] = []
for (let i = 0; i < Math.max(promptA2.length, promptB2.length); i++) {
  if (promptA2[i] !== promptB2[i]) changed.push(i)
}
check('§E switch moves exactly one resolved block', changed.length === 1, `changed blocks: ${changed.length}`, 'a model switch must change only the environment block of getSystemPrompt in src/engine/system-prompt/defaultSystemPrompt.ts')
check('§E the moved block is the environment section (its catalogue facts follow the model), naming no engine', changed.length === 1 && (promptA2[changed[0]!] ?? '').includes('# Environment') && lineOf([promptA2[changed[0]!] ?? '']) === '(no identity line)', '', 'the moved block must be the # Environment section and must not name the engine (src/engine/system-prompt/defaultSystemPrompt.ts)')

const entryPreClear = cache.get('env_info_simple')
clearSystemPromptSections()
const promptA3 = await getSystemPrompt([], MODEL_A)
check('§F cleared recompose mints a fresh entry', cache.get('env_info_simple') !== entryPreClear && lineOf(promptA3) === '(no identity line)', '', 'clearSystemPromptSections in src/engine/system-prompt/systemPromptSections.ts must empty the cache so the next getSystemPrompt mints a fresh entry')

const { settleModelSelection, settlePendingAtBoundary } = await import(
  '../../src/models/catalogue/modelTransition.ts'
)
const base = {
  engineModel: 'claude-opus-5' as string | null,
  engineModelForSession: null as string | null,
  pendingModelSwitch: null as { setting: string | null } | null,
}

const g1 = settleModelSelection(base, MODEL_B, { turnActive: false })
check(
  '§G1 idle apply patches model + mints an applied/idle receipt',
  g1.kind === 'applied' &&
    g1.patch?.engineModel === MODEL_B &&
    g1.receipt?.resolution === 'applied' &&
    g1.receipt?.boundary === 'idle' &&
    g1.receipt?.previous === 'claude-opus-5',
  '',
  'settleModelSelection in src/models/catalogue/modelTransition.ts must patch engineModel and mint an applied receipt with boundary idle when no turn is active',
)
check('§G1 same-provider switch is not cross-provider', g1.kind === 'applied' && g1.receipt.crossProvider === false, '', 'the receipt from settleModelSelection (src/models/catalogue/modelTransition.ts) must set crossProvider false for a same-provider switch')

const g2 = settleModelSelection(base, MODEL_B, { turnActive: true })
check(
  '§G2 mid-turn pick parks in the pending slot, no receipt yet',
  g2.kind === 'queued' && g2.patch?.pendingModelSwitch?.setting === MODEL_B && g2.receipt === null,
  '',
  'settleModelSelection in src/models/catalogue/modelTransition.ts must park a mid-turn pick in pendingModelSwitch and mint no receipt',
)

const g3 = settleModelSelection(
  { ...base, pendingModelSwitch: { setting: MODEL_B } },
  'claude-opus-5',
  { turnActive: true },
)
check(
  '§G3 same-model pick cancels the queued switch with a receipt',
  g3.kind === 'cancelled-pending' &&
    g3.patch?.pendingModelSwitch === null &&
    g3.receipt?.resolution === 'cancelled-pending' &&
    g3.receipt?.requested === MODEL_B &&
    g3.receipt?.applied === 'claude-opus-5',
  '',
  'settleModelSelection in src/models/catalogue/modelTransition.ts must cancel a queued switch when the current model is picked again, with a cancelled-pending receipt',
)

const g4 = settleModelSelection(base, 'claude-opus-5', { turnActive: false })
check('§G4 plain no-op writes nothing', g4.kind === 'no-op' && g4.patch === null && g4.receipt === null, '', 'settleModelSelection in src/models/catalogue/modelTransition.ts must return no patch and no receipt when the model is unchanged')

const g5 = settlePendingAtBoundary({ ...base, pendingModelSwitch: { setting: MODEL_B } })
check(
  '§G5 boundary settle applies the parked switch with a turn-boundary receipt',
  g5 !== null && g5.patch.engineModel === MODEL_B && g5.receipt.boundary === 'turn-boundary',
  '',
  'settlePendingAtBoundary in src/models/catalogue/modelTransition.ts must apply the parked switch with a turn-boundary receipt',
)
check('§G5 empty pending slot settles to null', settlePendingAtBoundary(base) === null, '', 'settlePendingAtBoundary in src/models/catalogue/modelTransition.ts must return null when no switch is parked')

const afterG1 = { ...base, engineModel: MODEL_B }
const g7 = settleModelSelection(afterG1, 'claude-opus-5', { turnActive: false })
check(
  '§G7 switch-back receipt chains (previous = the switched-to model)',
  g7.kind === 'applied' && g7.receipt?.previous === MODEL_B && g7.receipt?.applied === 'claude-opus-5',
  '',
  'settleModelSelection in src/models/catalogue/modelTransition.ts must set previous to the current engineModel of the state it is given',
)

check(
  '§G8 patch parks the receipt by identity (exactly-once consumption)',
  g1.kind === 'applied' && g1.patch?.lastModelTransition === g1.receipt,
  '',
  'the patch from settleModelSelection (src/models/catalogue/modelTransition.ts) must carry the same receipt object as lastModelTransition',
)

const g9 = settleModelSelection(base, 'gpt-5.6-sol', { turnActive: false })
check('§G9 cross-provider switch flagged in the receipt', g9.kind === 'applied' && g9.receipt.crossProvider === true, '', 'the receipt from settleModelSelection (src/models/catalogue/modelTransition.ts) must set crossProvider true when the provider changes')

{
  const applied = settleModelSelection(base, MODEL_B, { turnActive: false })
  const ALLOWED = new Set([
    'engineModel',
    'engineModelForSession',
    'pendingModelSwitch',
    'lastModelTransition',
  ])
  const patchKeys = Object.keys(applied.patch ?? {})
  check(
    '§H1 the owner patch is a closed leader-slot set (child state unreachable)',
    patchKeys.length > 0 && patchKeys.every(k => ALLOWED.has(k)),
    patchKeys.join(','),
    'the patch from settleModelSelection (src/models/catalogue/modelTransition.ts) may only carry the four leader-slot keys in ALLOWED',
  )
}

{
  const settled = settleModelSelection(base, MODEL_B, { turnActive: false })
  if (settled.kind !== 'applied') throw new Error('§I expects an applied settle')
  const { createModelTransitionMessage } = await import(
    '../../src/engine/message-shapes/systemMessages.ts'
  )
  const row = createModelTransitionMessage(settled.receipt)
  check(
    '§I1 transcript row mirrors the receipt',
    row.subtype === 'model_transition' &&
      row.previous === settled.receipt.previous &&
      row.applied === settled.receipt.applied &&
      row.resolution === 'applied',
    '',
    'createModelTransitionMessage in src/engine/message-shapes/systemMessages.ts must copy subtype, previous, applied and resolution from the receipt',
  )
  const { isTranscribable } = await import('../../src/sessions/transcripts/chain.ts')
  check('§I2 the row persists (loggable ⇒ transcript/resume/SDK agree)', isTranscribable(row as never), '', 'isTranscribable in src/sessions/transcripts/chain.ts must accept the model_transition row')
  const codec = await import('../../src/sessions/fabric/entryCodec.ts')
  const { ordinalOf } = await import('../../src/sessions/fabric/ordinal.ts')
  let ordN = 0
  const ctx = {
    sessionId: '00000000-0000-4000-8000-000000000001' as never,
    nextOrdinal: () => ordinalOf(++ordN) as never,
    observedAt: '2026-08-05T00:00:00.000Z',
    source: { channel: 'sdk' } as const,
  }
  const rec = codec.entryToRecord(
    { ...(row as unknown as Record<string, unknown>), sessionId: ctx.sessionId } as never,
    ctx as never,
  )
  const back = codec.recordToEntry(rec) as Record<string, unknown>
  check(
    '§I3 fabric round-trip preserves the transition facts',
    rec.payload.kind === 'notice' &&
      (rec.payload as { noticeKind?: string }).noticeKind === 'model_transition' &&
      back.subtype === 'model_transition' &&
      back.applied === MODEL_B,
    '',
    'entryToRecord and recordToEntry in src/sessions/fabric/entryCodec.ts must round-trip the model_transition row as a notice record',
  )
  check(
    '§I4 the patch writes the ONE store field every UI surface reads',
    settled.patch?.engineModel === MODEL_B,
    '',
    'the patch from settleModelSelection (src/models/catalogue/modelTransition.ts) must set engineModel to the applied model',
  )
}

console.log(failed === 0 ? '\n ✅ IDENTITY TRANSITION LAWS HOLD' : `\n ❌ ${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
