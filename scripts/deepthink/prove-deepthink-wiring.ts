#!/usr/bin/env bun
// prove-deepthink-wiring — structural ratchet for the ALIGNED
// deepthink contract: the keyword is a turn-scoped PROSE
// nudge and the retired turn-effort floor stays DEAD. A refactor that
// resurrects a wire point — or drops the drain-path nudge — fails here.
// Contract + research citations: src/utils/effort.ts (DEEPTHINK block).
//
//   §1 PRODUCER: the orchestrator hands the drained queue to the producer;
//      the producer scans pre-expansion text and returns the bare attachment.
//   §2 FLOOR IS DEAD: no floor symbol survives anywhere in src.
//   §3 RENDERER + TYPE: the attachment renders the default's EXACT sentence and
//      carries no level/envPinned payload.
//   §4 UI: the toast makes the default's exact claim, no level prediction.
//   §5 dist: the built bundle carries the aligned prose and none of the
//      floor-era strings (host-vs-binary check).
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
const ROOT = join(import.meta.dir, '..', '..')

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const section = (t: string): void =>
  console.log('\n' + '─'.repeat(76) + '\n' + t)
const src = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')

const DEFAULT_SENTENCE =
  'The user included the keyword "deepthink", requesting deeper reasoning on this turn. Reason as thoroughly as the task warrants.'

section('§1 producer + orchestrator wiring')
const modeLifecycles = src('src/utils/attachments/modeLifecycles.ts')
const orchestrator = src('src/utils/attachments/orchestrator.ts')
check(
  'producer scans the queued snapshot via queuedDeepthinkRequested',
  /queuedDeepthinkRequested\(queuedCommands \?\? \[\], hasDeepthinkKeyword\)/.test(
    modeLifecycles,
  ),
)
check(
  'producer returns the BARE attachment',
  modeLifecycles.includes("return [{ type: 'deepthink_effort' }]"),
)
check(
  'orchestrator passes queuedCommands into the producer',
  /getDeepthinkEffortAttachment\(\s*input,\s*toolUseContext,\s*options,\s*queuedCommands,\s*\)/m.test(
    orchestrator,
  ),
)
check(
  'the SKILL-body guard survives',
  modeLifecycles.includes('if (options?.skipSkillDiscovery) return []'),
)

section('§2 the turn-effort floor is DEAD in src')
const allSrc = ((): string => {
  const parts: string[] = []
  const walk = (dir: string): void => {
    for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(dir, e.name))
      else if (/\.(ts|tsx)$/.test(e.name)) parts.push(src(join(dir, e.name)))
    }
  }
  walk('src')
  return parts.join('\n')
})()
for (const dead of [
  'setTurnEffortFloor',
  'clearTurnEffortFloor',
  'getTurnEffortFloor',
  'applyTurnEffortFloor',
  'resolveDeepthinkTurnEffort',
  'deepthinkCeilingEnabled',
  'getDeepthinkFloorLevel',
  'turnEffortFloors',
  'MERCURY_DEEPTHINK_MAX',
  'HERMES_DEEPTHINK_MAX',
]) {
  check(`src carries no ${dead}`, !allSrc.includes(dead))
}

section('§3 renderer + type: base sentence, bare payload')
const attachmentText = src('src/utils/messages/attachmentText.ts')
const deepthinkCase = attachmentText.slice(
  attachmentText.indexOf("case 'deepthink_effort'"),
  attachmentText.indexOf("case 'deferred_tools_delta'"),
)
check('renderer case exists', deepthinkCase.length > 0)
check("renderer emits the default's EXACT sentence", deepthinkCase.includes(DEFAULT_SENTENCE))
check('renderer reads no attachment payload', !deepthinkCase.includes('attachment.level'))
const types = src('src/utils/attachments/types.ts')
const variantAt = types.indexOf("type: 'deepthink_effort'")
const variant = types.slice(Math.max(0, variantAt - 400), variantAt + 60)
check('type variant found', variantAt >= 0)
check('type variant carries no level field', !variant.includes('level?'))
check('type variant carries no envPinned field', !variant.includes('envPinned'))

section("§4 UI toast makes the default's exact claim")
const promptInput = src('src/components/PromptInput/PromptInput.tsx')
check(
  "toast text is 'deeper reasoning requested for this turn' (lowercase chrome, house voice)",
  promptInput.includes("text: 'deeper reasoning requested for this turn'"),
)
check('no level prediction in the input surface', !promptInput.includes('Effort raised to'))

section('§5 dist carries the aligned prose (host-vs-binary)')
const dist = readFileSync(join(ROOT, 'dist', 'mercury.mjs'), 'utf8')
check('bundle carries the base sentence', dist.includes(DEFAULT_SENTENCE))
check("bundle carries no floor-era toast ('Effort raised to')", !dist.includes('Effort raised to'))
check('bundle carries no MERCURY_DEEPTHINK_MAX', !dist.includes('MERCURY_DEEPTHINK_MAX'))

console.log('')
if (failures > 0) {
  console.log(`❌ ${failures} DEEPTHINK-WIRING PROOF(S) FAILED`)
  process.exit(1)
}
console.log('✅ ALL DEEPTHINK-WIRING PROOFS PASS')
