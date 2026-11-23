#!/usr/bin/env bun

let failures = 0
const t = (name: string, ok: boolean, detail = '', hint = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}${!ok && hint ? ` — ${hint}` : ''}`)
  if (!ok) failures = 1
}

const { safeUserFacingName } = await import('../../src/tools/kit/tool.ts')
const { BashTool } = await import('../../src/tools/shell/BashTool.tsx')

let threw = false
let named = ''
try {
  named = safeUserFacingName(BashTool as never, { command: 42 }, 'Bash')
} catch {
  threw = true
}
t('real Bash namer on a non-string command degrades, never throws', !threw, '', 'safeUserFacingName in src/tools/kit/tool.ts must catch a throw from the tool userFacingName, and the userFacingName in src/tools/shell/BashTool.tsx must not throw on a non-string command')
t('degraded name is the fallback', named === 'Bash', `got ${JSON.stringify(named)}`, 'safeUserFacingName in src/tools/kit/tool.ts must return the fallback argument when the namer throws')
t(
  'empty-string chrome opt-out passes through',
  safeUserFacingName({ name: 'x', userFacingName: () => '' }, {}) === '',
  '',
  'safeUserFacingName in src/tools/kit/tool.ts must return an empty string from the namer as is, not replace it with the fallback or the tool name',
)
t(
  'absent namer falls back to the tool name',
  safeUserFacingName({ name: 'x' }, {}) === 'x',
  '',
  'safeUserFacingName in src/tools/kit/tool.ts must return tool.name when the tool has no userFacingName and no fallback is given',
)

const { ProgressBar } = await import('../../src/screen/theme/ProgressBar.tsx')
for (const width of [-3, -1, 0, Number.NaN]) {
  let barThrew = false
  try {
    ProgressBar({ ratio: 0.5, width })
  } catch {
    barThrew = true
  }
  t(`ProgressBar renders at width ${width} without throwing`, !barThrew, '', 'ProgressBar in src/screen/theme/ProgressBar.tsx must clamp a negative, zero or NaN width before it builds the bar')
}

const { detectGitOperation } = await import('../../src/tools/kit/gitOperationTracking.ts')
const pathological = 'a..'.repeat(50_000)
const startedAt = performance.now()
detectGitOperation('git push origin main', pathological)
const elapsedMs = performance.now() - startedAt
t('pathological push output scans promptly', elapsedMs < 2000, `${Math.round(elapsedMs)}ms`, 'detectGitOperation in src/tools/kit/gitOperationTracking.ts must scan a long output without backtracking; check the push ref-update pattern it matches against')
const realPush = detectGitOperation(
  'git push origin main',
  'To github.com:acme/widget.git\n   ab12cd3..ef45ab6  main -> main\n',
)
t(
  'a real ref-update line still reads as a push',
  (realPush as { push?: { branch?: string } }).push?.branch === 'main',
  JSON.stringify(realPush),
  'detectGitOperation in src/tools/kit/gitOperationTracking.ts must still set push.branch from a normal ref-update line; the fix for slow scans must not tighten the push ref-update pattern past this line',
)

process.exit(failures)
