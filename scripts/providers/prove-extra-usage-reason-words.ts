;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { anthropicExtraUsageCredits, anthropicExtraUsageCarry } = await import('../../src/services/providers/providerUsage.ts')
let failures = 0
function check(label: string, ok: boolean, detail: string): void {
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${ok ? '' : ` — ${detail}`}`)
}
for (const reason of ['new_provider_reason', 'org_level_disabled', 'org_service_zero_credit_limit', 'opaque_reason_123']) {
  const record = { stated: true, enabled: false, disabledReason: reason, source: 'endpoint', observedAtMs: 123 }
  const reads = { anthropicExtraUsage: () => record } as never
  const credits = anthropicExtraUsageCredits(reads)
  const carry = anthropicExtraUsageCarry(reads)
  const headerCarry = anthropicExtraUsageCarry({ anthropicExtraUsage: () => null, anthropicLimits: () => ({ status: 'rejected', overageStatus: 'rejected', overageDisabledReason: reason }) } as never)
  for (const [name, text] of [['credits', credits.reason], ['carry', carry.display], ['headers', headerCarry.display]] as const) {
    check(`${name} states the known fact for an unfamiliar reason`, text?.includes('Extra usage is disabled') === true, String(text))
    check(`${name} never turns a raw reason into prose`, !String(text).includes(reason) && !String(text).includes(reason.replace(/_/g, ' ')), String(text))
  }
  check('the raw provider record is unchanged', record.disabledReason === reason, record.disabledReason)
  check('the reading retains its state and stamp', credits.state === 'unreported' && credits.observedAtMs === 123 && carry.state === 'nothing', JSON.stringify({ credits, carry }))
}
for (const [reason, words] of [['out_of_credits', 'out of credits'], ['org_level_disabled_until', 'temporarily disabled by your organisation']]) {
  const reads = { anthropicExtraUsage: () => ({ stated: true, enabled: false, disabledReason: reason, source: 'endpoint', observedAtMs: 123 }) } as never
  check(`a known ${reason} retains its fact`, String(anthropicExtraUsageCredits(reads).reason).includes(words!) && anthropicExtraUsageCarry(reads).display.includes(words!), JSON.stringify(reads))
}
console.log(`extra-usage-reason-words: ${failures} failures`)
process.exit(failures ? 1 : 0)
