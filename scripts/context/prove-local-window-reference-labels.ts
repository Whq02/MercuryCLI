import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.MERCURY_DISABLE_NONESSENTIAL_TRAFFIC = '1'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
const arg = process.argv.indexOf('--source-root')
const root = arg < 0 ? resolve(dirname(fileURLToPath(import.meta.url)), '../..') : resolve(process.argv[arg + 1]!)
const { enableConfigs } = await import(`${root}/src/utils/config.ts`)
enableConfigs()
const { setEngineModelOverride } = await import(`${root}/src/bootstrap/state.ts`)
const { publishContextUsage } = await import(`${root}/src/utils/cockpit/contextUsageLive.ts`)
const { runHealthReport } = await import(`${root}/src/utils/healthReport.ts`)
const { liveModelsReferenceText } = await import(`${root}/src/services/resources/adapters/models.ts`)
let checks = 0
let failures = 0
const check = (label: string, pass: boolean, detail: string): void => {
  checks++
  if (!pass) failures++
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${label}: ${detail}`)
}
for (const [model, window, gauge, reference] of [
  ['local/fixture', 32768, '32k', '32k'],
  ['local/fixture', 65536, '64k', '64k'],
  ['local/fixture', 33000, '33k', '33k'],
  ['claude-fable-5-1', 32768, '33k', '33k'],
  ['local/fixture', 1000001, '1000k', '1.000001M'],
  ['claude-fable-5-1', 1048576, '1049k', '1.048576M'],
] as const) {
  setEngineModelOverride(model)
  publishContextUsage(25, window, 80)
  const report = await runHealthReport({ depth: 'fast' })
  const context = report.sections.flatMap((section: { checks: { id: string; evidence: string }[] }) => section.checks).find((row: { id: string }) => row.id === 'context')
  check(`${model}, ${window}: health's Context & resume`, context?.evidence.startsWith(`context 25% of ${gauge} ·`), context?.evidence ?? '(absent)')
  const text = liveModelsReferenceText({ readAt: 'fixture', providers: [{ provider: model.startsWith('local/') ? 'local' : 'anthropic', providerName: 'Fixture', account: 'fixture', list: { kind: 'static', words: 'fixture' }, models: [{ id: model, displayName: model, contextWindow: window }] }], notSignedIn: [] })
  const row = text.split('\n').find((line: string) => line.startsWith(`  ${model}  `)) ?? '(absent)'
  check(`${model}, ${window}: mercury://models`, row === `  ${model}  ${reference} window`, row)
}
setEngineModelOverride(null)
console.log(`${checks - failures}/${checks} checks; ${failures} red`)
process.exit(failures === 0 ? 0 : 1)
