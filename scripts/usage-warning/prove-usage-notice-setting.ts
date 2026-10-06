import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LimitWarningReads } from '../../src/services/providers/limitWarning.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const root = mkdtempSync(join(tmpdir(), 'usage-notice-setting-'))
process.env.MERCURY_CONFIG_DIR = join(root, 'home')
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
const project = join(root, 'project')
mkdirSync(join(project, '.mercury'), { recursive: true })
const { SettingsSchema } = await import('../../src/utils/settings/types.js')
const pipeline = await import('../../src/utils/settings/settings.js')
const { resetSettingsCache } = await import('../../src/utils/settings/settingsCache.js')
const state = await import('../../src/bootstrap/state.js')
state.setOriginalCwd(project)
state.setAllowedSettingSources(['userSettings', 'projectSettings', 'localSettings'])
const userFile = join(process.env.MERCURY_CONFIG_DIR, 'settings.json')
writeFileSync(userFile, '{}')

const { getUsageLimitNoticeAttachment } = await import('../../src/utils/attachments/sessionContext.ts')
const { usageWarningNoticeText } = await import('../../src/services/providers/limitWarning.ts')

const reset = Math.floor(Date.now() / 1000) + 604800
const entry = { id: 'fixture', provider: 'anthropic', kind: 'subscription-oauth', label: 'fixture', custodian: 'anthropic-slots' } as const
const limits = { status: 'allowed' as const, isUsingOverage: false, unifiedRateLimitFallbackAvailable: false }
const reads = (pct: number): LimitWarningReads => ({
  route: () => 'anthropic',
  activeEntry: () => entry,
  spend: () => ({ inputTokens: 0, outputTokens: 0, costUSD: 0, models: 0 }),
  anthropicPlan: () => 'max',
  anthropicLimits: () => limits,
  anthropicWindows: () => ({
    fiveHour: { key: '5h', state: 'live', usedPct: 12, resetsAtMs: reset * 1000 },
    sevenDay: { key: '7d', state: 'live', usedPct: pct, resetsAtMs: reset * 1000 },
  }),
  anthropicPoolWindows: () => [],
})
const overageReads: LimitWarningReads = {
  ...reads(12),
  anthropicLimits: () => ({ ...limits, isUsingOverage: true, overageStatus: 'allowed_warning' }),
} as LimitWarningReads
const context = { options: { engineModel: 'fable' } } as Parameters<typeof getUsageLimitNoticeAttachment>[0]
const setSetting = (value: boolean | undefined): void => {
  writeFileSync(userFile, JSON.stringify(value === undefined ? {} : { engine: { usageNotice: value } }))
  resetSettingsCache()
}

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

check('engine.usageNotice is a declared setting', (() => {
  const schema = SettingsSchema() as { def?: { shape?: Record<string, { def?: { innerType?: { def?: { shape?: Record<string, unknown> } } } }> } }
  const engine = schema.def?.shape?.engine
  const inner = engine?.def?.innerType
  const engineShape = (inner as { def?: { shape?: Record<string, unknown> } } | undefined)?.def?.shape ?? (inner as { shape?: Record<string, unknown> } | undefined)?.shape
  return typeof engineShape?.usageNotice !== 'undefined'
})())
check('engine.usageNotice absent parses to absence', (() => {
  const parsed = SettingsSchema().parse({ engine: { model: 'fable' } }) as { engine?: { usageNotice?: boolean } }
  return parsed.engine?.usageNotice === undefined
})())
check('engine.usageNotice accepts true and false', (() => {
  const on = SettingsSchema().safeParse({ engine: { usageNotice: true } })
  const off = SettingsSchema().safeParse({ engine: { usageNotice: false } })
  const bad = SettingsSchema().safeParse({ engine: { usageNotice: 'yes' } })
  return on.success && off.success && !bad.success
})())

const messages: unknown[] = []
setSetting(undefined)
check('unset: the 80% window reaches no attachment', getUsageLimitNoticeAttachment(context, messages, reads(80)).length === 0)
check('unset: the 90% window reaches no attachment', getUsageLimitNoticeAttachment(context, messages, reads(90)).length === 0)
check('unset: the spending-limit state reaches no attachment', getUsageLimitNoticeAttachment(context, messages, overageReads).length === 0)
check('unset: the transcript keeps no notice row', !JSON.stringify(messages).includes('usage_limit_notice'))
const offFacts = (await import('../../src/services/providers/limitWarning.ts')).providerLimitWarningFacts({ model: 'fable', reads: reads(80) })
check('unset: the facts road still reads the window (the user meters keep their owner)', offFacts !== null && offFacts.pct === 80)

setSetting(false)
check('off: the 80% window reaches no attachment', getUsageLimitNoticeAttachment(context, messages, reads(80)).length === 0)
check('off: the spending-limit state reaches no attachment', getUsageLimitNoticeAttachment(context, messages, overageReads).length === 0)

setSetting(true)
const first = getUsageLimitNoticeAttachment(context, messages, reads(80))
check('on: the 80% window attaches exactly as the base did', first.length === 1 && first[0]!.type === 'usage_limit_notice' && first[0]!.pct === 80 && first[0]!.provider === 'anthropic')
const second = getUsageLimitNoticeAttachment(context, [...messages, ...first.map(a => ({ type: 'attachment', attachment: a }))], reads(90))
check('on: the 90% window attaches after the first', second.length === 1 && second[0]!.pct === 90)
const overage = getUsageLimitNoticeAttachment(context, messages, overageReads)
check('on: the spending-limit state attaches with the base words', overage.length === 1 && overage[0]!.pct === 0 && overage[0]!.text === 'Anthropic says this account is close to its extra usage spending limit')
check('on: the words are byte-equal to the base law', usageWarningNoticeText(overage[0]!.text, 0).startsWith('Usage limit near — Anthropic says this account is close to its extra usage spending limit.'))
check('on: the render law is untouched', readFileSync(new URL('../../src/utils/messages/attachmentText.ts', import.meta.url), 'utf8').includes("case 'usage_limit_notice':"))
setSetting(undefined)

rmSync(root, { recursive: true, force: true })
console.log(`usage notice setting: ${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)
