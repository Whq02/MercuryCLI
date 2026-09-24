;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { enableConfigs } = await import('../../src/utils/config.js')
enableConfigs()
const learned = await import('../../src/services/api/clientContractLearned.js')
const refusal = {
  status: 400,
  message: `${process.env.HEAL_SENT ?? ''} does not support this model; version ${process.env.HEAL_FLOOR ?? ''} or newer is required`,
}
const outcome = await learned.healClientContractRefusal(refusal)
console.log(JSON.stringify(outcome))
process.exit(0)
