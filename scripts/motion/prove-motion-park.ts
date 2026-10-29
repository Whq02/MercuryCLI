#!/usr/bin/env bun

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtempSync, rmSync } from 'node:fs'
import { grabScreens, runArtifactArena } from '../streaming/artifactArena.ts'
import { vshotBudgetMs as S } from '../lib/captureDriver.ts'
import { SHIMMER_GREETING_MS } from '../../src/utils/cockpit/greetingShimmer.ts'

let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : ` — ${detail}`}`)
  if (!ok) failures++
}

console.log('── motion park under a claims-modal (shipped artifact) ──')

const src = (p: string): string => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8')
check(
  'use-animation-value reads MotionParkContext',
  src('src/ink/hooks/use-animation-value.ts').includes('MotionParkContext'),
)
check(
  'use-animation-frame reads MotionParkContext',
  src('src/ink/hooks/use-animation-frame.ts').includes('MotionParkContext'),
)
check(
  'useNowTick reads MotionParkContext',
  src('src/components/mercury-ui/components.tsx').includes('MotionParkContext'),
)
{
  const fsl = src('src/components/FullscreenLayout.tsx')
  check(
    'FullscreenLayout provides the park on the always-mounted root',
    fsl.includes('MotionParkContext.Provider value={motionParked}'),
  )
  check(
    'the modal slot re-provides false (its own primitives stay live)',
    fsl.includes('MotionParkContext.Provider value={false}'),
  )
}

const teeDir = mkdtempSync(join(tmpdir(), 'glide-park-'))
const tee = join(teeDir, 'tee.jsonl')
const run = await runArtifactArena({
  turns: [{ kind: 'text', text: 'REPLY-PARK done.' }],
  sends: ['after:Type a prompt:500:warm up\\r', 'after:REPLY-PARK done.:500:/help\\r', 'after:Mercury — help:19000:\\x1b'],
  seconds: 45,
  keep: true,
  extraEnv: { MERCURY_LIVE_GLYPHS: '1', INK_COMPOSED_TEE: tee },
})

interface TeeRec {
  f: number
  ts: number
  rows: string[]
}
const recs: TeeRec[] = []
for (const line of readFileSync(tee, 'utf8').split('\n')) {
  if (!line.trim()) continue
  try {
    const j = JSON.parse(line) as TeeRec
    if (typeof j.f === 'number' && Array.isArray(j.rows)) recs.push(j)
  } catch {
  }
}
const isModal = (r: { rows: string[] }): boolean => r.rows.some(row => row.startsWith('▔▔▔▔'))
const modal = recs.filter(isModal)
check('the help sheet opened as a claims-modal', modal.length >= 1, `frames=${modal.length}`)

if (modal.length >= 1) {
  const openTs = modal[0]!.ts
  const quietFrom = openTs + SHIMMER_GREETING_MS + 1500
  const quietTo = quietFrom + 6000
  const win = recs.filter(r => r.ts >= quietFrom && r.ts <= quietTo)
  let identical = 0
  for (let i = 1; i < win.length; i++) {
    if (win[i]!.rows.join('\n') === win[i - 1]!.rows.join('\n')) identical++
  }
  check(
    'the settled covered window is quiet (≤3 byte-identical composes in 6s; unfixed 14+)',
    isModal(recs.filter(r => r.ts <= quietFrom).at(-1) ?? { rows: [] }) && isModal(recs.filter(r => r.ts <= quietTo).at(-1) ?? { rows: [] }) && win.every(isModal) && identical <= 3,
    `identical=${identical} composes=${win.length}`,
  )
  const closeFrame = recs.find(r => r.ts > quietTo && !isModal(r))
  check('the help closed (a non-modal compose follows coverage)', closeFrame !== undefined)
  if (closeFrame) {
    const resumed = recs.filter(r => r.ts >= closeFrame.ts && r.ts <= closeFrame.ts + 3000)
    check('motion resumes after close (≥2 composes in 3s)', resumed.length >= 2, `resumed=${resumed.length}`)
  }
}

const [snap] = grabScreens(run, 120, 40, [S(12000)])
check('the covered-window help frame is intact', snap !== undefined && isModal(snap))

run.cleanup()
rmSync(teeDir, { recursive: true, force: true })

console.log(failures === 0 ? '✅ motion-park GREEN' : `❌ motion-park RED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
