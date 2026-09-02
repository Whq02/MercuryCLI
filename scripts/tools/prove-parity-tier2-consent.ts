#!/usr/bin/env bun
// ============================================================================
//  prove-parity-tier2-consent — frontier-sweep #1, tier 2 mechanisms:
//
//   1. The inbound-delivery decision table (item 56): a session in a
//      bypass-permissions mode HOLDS inbound teammate messages while the
//      gate flag is on — idle or busy — and prompting-mode sessions keep
//      the historical submit/park behavior exactly. The gate flag is
//      registered, default-on, and '=0' restores auto-delivery.
//   2. The shell tools state where command output goes (item 57): both the
//      bash and PowerShell descriptions carry the output-visibility clause.
// ============================================================================

let failures = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures = 1
}

// —— 1. the delivery decision table ——————————————————————————————————
const { classifyInboundDelivery } = await import('../../src/hooks/useInboxPoller.ts')
const table: Array<{
  idle: boolean
  bypassMode: boolean
  holdGateOn: boolean
  expect: string
}> = [
  { idle: true, bypassMode: true, holdGateOn: true, expect: 'hold' },
  { idle: false, bypassMode: true, holdGateOn: true, expect: 'hold' },
  { idle: true, bypassMode: true, holdGateOn: false, expect: 'submit' },
  { idle: false, bypassMode: true, holdGateOn: false, expect: 'park-pending' },
  { idle: true, bypassMode: false, holdGateOn: true, expect: 'submit' },
  { idle: false, bypassMode: false, holdGateOn: true, expect: 'park-pending' },
]
for (const row of table) {
  const got = classifyInboundDelivery(row)
  t(
    `delivery(idle=${row.idle} bypass=${row.bypassMode} gate=${row.holdGateOn}) = ${row.expect}`,
    got === row.expect,
    `got ${got}`,
  )
}

// —— gate flag registration + live re-read ———————————————————————————
const { flagEnabled } = await import('../../src/substrate/flagRegistry.ts')
delete process.env.MERCURY_INBOX_HOLD_BYPASS
t('hold gate is default-on', flagEnabled('MERCURY_INBOX_HOLD_BYPASS') === true)
process.env.MERCURY_INBOX_HOLD_BYPASS = '0'
t("'=0' restores auto-delivery", flagEnabled('MERCURY_INBOX_HOLD_BYPASS') === false)
delete process.env.MERCURY_INBOX_HOLD_BYPASS

// —— 2. shell output-visibility clause ———————————————————————————————
const bash = await import('../../src/tools/BashTool/prompt.ts')
const bashDescription: string = bash.getSimplePrompt()
t(
  'bash description says output reaches the model, not reliably the operator',
  bashDescription.includes('the operator does not reliably see it'),
)
const powershell = await import('../../src/tools/PowerShellTool/prompt.ts')
const psDescription: string = await powershell.getPrompt()
t(
  'PowerShell description carries the same clause',
  psDescription.includes('the operator does not reliably see it'),
)

process.exit(failures)
