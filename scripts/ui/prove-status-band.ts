#!/usr/bin/env bun

let failures = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ` — ${detail}`}`)
  if (!ok) failures = 1
}

const { openStatusPart } = await import('./chatScenarios.ts')
const { IDLE_LIVE } = await import('../../src/engine/connector/seatLive.ts')
const status = await openStatusPart('status-band-strip', { keepHome: true })
const drawn = (): string => (['spinner', 'hold', 'rollup'] as const).filter(name => status.handed[name] !== null).join('+')
const resting = drawn()
await status.plant({ seatLive: { ...IDLE_LIVE, inFlight: true, phase: 'thinking' } })
const working = drawn()
await status.plant({ textActive: true })
const streaming = drawn()
const mostSpinners = status.mostSpinners()
await status.close()
t('strip carries the spinner + the streaming hold + the rollup', resting === 'rollup' && working === 'spinner+rollup' && streaming === 'hold+rollup', `rows drawn: resting "${resting}" (want rollup), working "${working}" (want spinner+rollup), streaming "${streaming}" (want hold+rollup); to fix: change workingStatusStrip in useChatStatusStrip, src/screen/chat/useChatStatus.tsx`)


console.log(failures ? '\n❌ STATUS-BAND RED' : '\n✅ STATUS-BAND GREEN')
process.exit(failures)
