import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mountOffscreen, waitFor } from '../lib/settingsPopupHarness.ts'

assert.ok(process.env.MERCURY_CONFIG_DIR)
delete process.env.MERCURY_HOME
process.env.NODE_ENV = 'test'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
globalThis.fetch = Object.assign(async () => { throw new Error('No network in the rental usage proof') }, globalThis.fetch)
const { enableConfigs, saveGlobalConfig } = await import('../../src/utils/config.ts')
enableConfigs()
const model = 'compat/pod-current/openai/gpt-oss-120b'
saveGlobalConfig(config => ({ ...config, compatProvider: {
  'pod-old': { baseUrl: 'http://127.0.0.1:1/v1', models: ['old'], hostPodId: 'old' },
  'pod-current': { baseUrl: 'http://127.0.0.1:2/v1', models: ['openai/gpt-oss-120b'], hostPodId: 'current' },
} }))
const { writeHostRecord, removeHostRecord } = await import('../../src/services/host/store.ts')
const { NoSessionConnector } = await import('../../src/services/engine-connector/noSessionConnector.ts')
const { setFocusedSessionConnector, releaseFocusedSessionConnector } = await import('../../src/services/engine-connector/focusedConnector.ts')
const connector = new NoSessionConnector()
connector.modelFacts = () => ({ main: model, effective: model, setting: model, sessionPin: model, pendingSwitch: null })
setFocusedSessionConnector(connector)
const now = Date.now()
writeHostRecord({ id: 'old', name: 'Old rental', recipe: 'gpt-oss-120b-h100', price: 1, startedAt: new Date(now - 3_600_000).toISOString(), status: 'RUNNING', provider: 'pod-old' })
writeHostRecord({ id: 'current', name: 'Current rental', recipe: 'gpt-oss-120b-h100', price: 3.99, startedAt: new Date(now - 6 * 60_000).toISOString(), status: 'RUNNING', provider: 'pod-current' })
const React = await import('react')
const { Usage, usageCompactLines, usageSectionPlan } = await import('../../src/components/Settings/Usage.tsx')
const { ThemeProvider } = await import('../../src/components/design-system/ThemeProvider.tsx')
const { AppStateProvider } = await import('../../src/state/AppState.tsx')
let mounted: Awaited<ReturnType<typeof mountOffscreen>> | undefined
let failures = 0
const check = (label: string, ok: boolean, detail = '') => { if (!ok) failures++; console.log((ok ? 'PASS ' : 'FAIL ') + label + (!ok ? '\n' + detail : '')) }
try {
  mounted = await mountOffscreen(React.createElement(AppStateProvider, { children: React.createElement(ThemeProvider, {}, React.createElement(Usage, { width: 100, rowBudget: 30 })) }), 100, 30)
  await waitFor(() => mounted!.screen().includes('Custom endpoint usage'), 5000)
  const screen = mounted.screen()
  const at = process.argv.indexOf('--frames')
  const frames = at < 0 ? undefined : process.argv[at + 1]
  if (frames) {
    mkdirSync(frames, { recursive: true })
    const grid = mounted.lines().map((line, y) => Array.from(line.padEnd(100)).map((c, x) => ({ c, bg: mounted!.styleAt(x, y)?.bg ?? 'default', fg: mounted!.styleAt(x, y)?.fg ?? 'default', bold: mounted!.styleAt(x, y)?.bold ?? false })))
    const path = join(frames, 'rental-usage-100x30.json')
    writeFileSync(path, JSON.stringify({ grid, cols: 100, rows: 30 }))
    const { gridToPng } = await import('./gridToPng.ts')
    await gridToPng(path, join(frames, 'rental-usage-100x30.png'))
  }
  check('F44R-24: Usage names the seated rental, never the old endpoint', screen.includes('current') && !screen.includes('pod-old'), screen)
  check('F44R-24: rental row states rate, elapsed and cents spent', screen.includes('$3.99/hr') && /6m|6 min/.test(screen) && screen.includes('$0.40'), screen)
  check('F44R-24: a paid rental is neither local nor token-unpriced', !/local\/auth-free|unpriced|connects by API key/.test(screen), screen)
  const plan = usageSectionPlan([{ id: 'openai-compat', available: true, credentialed: true, credentialLabel: 'pod-old' }])
  const compact = usageCompactLines(plan).map(row => row.text).join('\n')
  check('compact Usage names the same rental and its cost', compact.includes('current') && compact.includes('$3.99/hr') && compact.includes('$0.40') && !compact.includes('pod-old'), compact)
  const { activeSourceUsage } = await import('../../src/services/providers/providerUsage.ts')
  const usage = activeSourceUsage({ model }) as ReturnType<typeof activeSourceUsage> & { rental?: { spendUSD: number; price: number; id: string } }
  check('F44R-23: active spend resolves the seated rental', usage.rental?.id === 'current' && usage.rental.price === 3.99 && Math.abs(usage.rental.spendUSD - 0.399) < 0.01, JSON.stringify(usage.rental))
  const rail = readFileSync(join(import.meta.dir, '../../src/utils/cockpit/helmLanesModel.ts'), 'utf8')
  check('F44R-23: the rail spells rental spend in cents ahead of token spend', /usage\.rental/.test(rail) && /rental\.spendUSD\.toFixed\(2\)/.test(rail))
  const railFace = readFileSync(join(import.meta.dir, '../../src/components/HelmLanesRail.tsx'), 'utf8')
  check('the rail resolves usage for the seated model rather than the saved default', railFace.includes('activeSourceUsage({ model: getFocusedSessionConnector().modelFacts().effective })'))
  const { formatCost } = await import('../../src/utils/spendSpelling.ts')
  check('provider sub-cent formatting is unchanged', formatCost(0.0007) === '$0.0007')
} finally { mounted?.unmount(); releaseFocusedSessionConnector(); removeHostRecord('old'); removeHostRecord('current') }
process.exitCode = failures ? 1 : 0
