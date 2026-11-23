#!/usr/bin/env bun
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { mountOffscreen, pinScratchHome, releaseScratchHome, waitFor } from '../lib/settingsPopupHarness.ts'
import { lockupCensus, ROLE_BY_FILE } from './gen-lockup-census.ts'

const ROOT = join(import.meta.dir, '..', '..')
let failed = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failed++
  const fix = label.startsWith('§A zero') ? 'classify the site in ROLE_BY_FILE in scripts/consistency-census/gen-lockup-census.ts, or remove the lockup site'
    : label.startsWith('§A') ? 'drop or rename the stale entry in ROLE_BY_FILE in scripts/consistency-census/gen-lockup-census.ts'
    : label.startsWith('§B') ? 'ProductLockup in src/screen/widgets/components.tsx must still paint the title; check its use in src/commands/model/picker/MercuryModelPicker.tsx and CommandCenter in src/screen/widgets/components.tsx'
    : label.startsWith('§C') ? 'draw the crab glyph only through src/screen/widgets/assets.tsx or src/screen/cockpit/critterData.ts, or add the file to ALLOWED_GLYPH_AUTHORS in this script'
    : 'give every role a site in ROLE_BY_FILE in scripts/consistency-census/gen-lockup-census.ts'
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}${cond ? '' : ` (${fix})`}`)
}

const census = lockupCensus(ROOT)
const unclassified = census.sites.filter(s => s.role === 'UNCLASSIFIED')
check('§A zero unclassified production sites', unclassified.length === 0, String(unclassified.length))
if (unclassified.length > 0) {
  for (const s of unclassified) console.log(`    ${s.file} (${s.kind}) ${s.excerpt}`)
  console.log('    classify it in ROLE_BY_FILE in scripts/consistency-census/gen-lockup-census.ts, or remove the lockup site')
}
const classified = Object.keys(ROLE_BY_FILE)
const classifiedAbsent = classified.filter(file => !existsSync(join(ROOT, file)))
check('§A every file the role table classifies stands in the tree', classified.length > 0 && classifiedAbsent.length === 0, classifiedAbsent.join(', '))
{
  const prevCwd = process.cwd()
  const scratchHome = pinScratchHome('lockup-census')
  process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
  const React = await import('react')
  const { enableConfigs } = await import('../../src/platform/settings/config.js')
  enableConfigs()
  const { Text } = await import('../../src/screen/themedRenderer.js')
  const { MercuryModelPicker } = await import('../../src/commands/model/picker/MercuryModelPicker.js')
  const { CommandCenter } = await import('../../src/screen/widgets/components.js')
  const pickerMounted = await mountOffscreen(
    React.createElement(MercuryModelPicker as never, {
      models: [{ id: 'claude-fable-5-1', name: 'Fable 5.1', tag: '', ctx: '1M ctx', group: 'Anthropic' }],
      current: 'claude-fable-5-1',
    }),
    120,
    30,
  )
  try {
    const pickerOk = await waitFor(() => pickerMounted.screen().includes('Mercury · model'), 4000)
    check('§B /model renders the shared ProductLockup', pickerOk, pickerOk ? '' : pickerMounted.screen().slice(0, 300))
  } finally {
    pickerMounted.unmount()
  }
  const centerMounted = await mountOffscreen(
    React.createElement(
      CommandCenter as never,
      { view: 'sessions', subtitle: '3 active', onClose: () => {} },
      React.createElement(Text as never, {}, 'body'),
    ),
    120,
    30,
  )
  try {
    const centerOk = await waitFor(
      () => {
        const frame = centerMounted.screen()
        return frame.includes('▟▆▙') && frame.includes('Mercury — sessions') && frame.includes('3 active')
      },
      4000,
    )
    check('§B CommandCenter consumes the SAME ProductLockup line', centerOk, centerOk ? '' : centerMounted.screen().slice(0, 300))
  } finally {
    centerMounted.unmount()
    await releaseScratchHome(scratchHome)
    process.chdir(prevCwd)
  }
}

const ALLOWED_GLYPH_AUTHORS = new Set([
  'src/screen/cockpit/critterData.ts',
  'src/screen/widgets/assets.tsx',
])
const glyphHits = execFileSync('git', ['grep', '-n', '▟▆▙', '--', 'src'], {
  cwd: ROOT,
  encoding: 'utf8',
})
  .split('\n')
  .filter(Boolean)
  .map(l => {
    const [file, line, ...rest] = l.split(':')
    return { file: file!, line: line!, text: rest.join(':').trim() }
  })
  .filter(h => !ALLOWED_GLYPH_AUTHORS.has(h.file))
  .filter(h => !h.file.endsWith('.md'))
  .filter(h => !h.text.startsWith('//') && !h.text.startsWith('*'))
check(
  '§C the crab glyph run renders only through the owners (no hand-drawn copies)',
  glyphHits.length === 0,
  glyphHits.map(h => `${h.file}:${h.line}`).join(', '),
)

const roles = new Set(census.sites.map(s => s.role))
check(
  '§D all five roles present (hierarchy is real, not one gradient bucket)',
  ['product-identity-header', 'mission-focal-title', 'session-identity', 'compact-status-inline'].every(r => roles.has(r)),
  [...roles].join(', '),
)

console.log(failed === 0 ? '\n ✅ ONE PRODUCT-LOCKUP CONTRACT HOLDS' : `\n ❌ ${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
