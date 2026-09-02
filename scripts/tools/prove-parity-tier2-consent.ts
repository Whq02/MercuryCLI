#!/usr/bin/env bun

let failures = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures = 1
}

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

const { flagEnabled } = await import('../../src/substrate/flagRegistry.ts')
delete process.env.MERCURY_INBOX_HOLD_BYPASS
t('hold gate is default-on', flagEnabled('MERCURY_INBOX_HOLD_BYPASS') === true)
process.env.MERCURY_INBOX_HOLD_BYPASS = '0'
t("'=0' restores auto-delivery", flagEnabled('MERCURY_INBOX_HOLD_BYPASS') === false)
delete process.env.MERCURY_INBOX_HOLD_BYPASS

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
