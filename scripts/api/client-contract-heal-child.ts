;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { enableConfigs } = await import('../../src/utils/config.js')
enableConfigs()
const learned = await import('../../src/services/api/clientContractLearned.js')
await import('../../src/constants/oauth.js')
const refusal = {
  status: 400,
  message: `${process.env.HEAL_SENT ?? ''} does not support this model; version ${process.env.HEAL_FLOOR ?? ''} or newer is required`,
}
const lag = Number(process.env.HEAL_CLOCK_LAG_MS ?? '0') || 0
if (process.env.HEAL_WAIT_FOR_GO === '1') {
  console.log('ready')
  await new Promise<void>(resolve => process.stdin.once('data', () => resolve()))
}
const outcome = await learned.healClientContractRefusal(refusal, undefined, () => Date.now() - lag)
console.log(JSON.stringify(outcome))
process.exit(0)
