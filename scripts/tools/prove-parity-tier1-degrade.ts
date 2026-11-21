#!/usr/bin/env bun

let failures = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures = 1
}

const { safeUserFacingName } = await import('../../src/Tool.ts')
const { BashTool } = await import('../../src/tools/BashTool/BashTool.tsx')

let threw = false
let named = ''
try {
  named = safeUserFacingName(BashTool as never, { command: 42 }, 'Bash')
} catch {
  threw = true
}
t('real Bash namer on a non-string command degrades, never throws', !threw)
t('degraded name is the fallback', named === 'Bash', `got ${JSON.stringify(named)}`)
t(
  'empty-string chrome opt-out passes through',
  safeUserFacingName({ name: 'x', userFacingName: () => '' }, {}) === '',
)
t(
  'absent namer falls back to the tool name',
  safeUserFacingName({ name: 'x' }, {}) === 'x',
)

const { ProgressBar } = await import('../../src/components/design-system/ProgressBar.tsx')
for (const width of [-3, -1, 0, Number.NaN]) {
  let barThrew = false
  try {
    ProgressBar({ ratio: 0.5, width })
  } catch {
    barThrew = true
  }
  t(`ProgressBar renders at width ${width} without throwing`, !barThrew)
}

const { detectGitOperation } = await import('../../src/tools/shared/gitOperationTracking.ts')
const pathological = 'a..'.repeat(50_000)
const startedAt = performance.now()
detectGitOperation('git push origin main', pathological)
const elapsedMs = performance.now() - startedAt
t('pathological push output scans promptly', elapsedMs < 2000, `${Math.round(elapsedMs)}ms`)
const realPush = detectGitOperation(
  'git push origin main',
  'To github.com:acme/widget.git\n   ab12cd3..ef45ab6  main -> main\n',
)
t(
  'a real ref-update line still reads as a push',
  (realPush as { push?: { branch?: string } }).push?.branch === 'main',
  JSON.stringify(realPush),
)

process.exit(failures)
