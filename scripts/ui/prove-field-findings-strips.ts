#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')
const ordered = (hay: string, a: string, b: string): boolean => {
  const ia = hay.indexOf(a)
  const ib = hay.indexOf(b)
  return ia !== -1 && ib !== -1 && ia < ib
}

let failures = 0
const check = (name: string, ok: boolean, detail?: string): void => {
  if (ok) {
    console.log(`  ok  ${name}`)
  } else {
    failures++
    console.error(`  RED ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

console.log('§1 SSR-01 — the trim chip rides with the hints, right of every vital')
{
  const frame = read('src/components/MercuryFrame.tsx')
  const row = frame.slice(frame.indexOf('<Text wrap="truncate-end">\n        <SessionMark />'), frame.indexOf('{mouseNode}\n      </Text>') + '{mouseNode}'.length)
  check('the statusbar row was found', row.length > 100)
  check('POISON: the chip no longer sits in the model block', !/<HarnessChip model=\{model\} show=\{showBehavior\} \/>\s*\n\s*<TrimChip \/>/.test(row))
  check('the chip prints after the run capsule and before the mouse hint', ordered(row, '{runNode}', '<TrimChip />') && ordered(row, '<TrimChip />', '{mouseNode}'))
  check('every vital precedes it (folder · branch · turns · ctx · cost · usage · health · vfy · run)', ['{dir}', 'truncateToWidth(branch, branchMax)', '{turnsNode}', '{ctxNode}', 'costNode', 'usageNode', '{healthNode}', '{vfyNode}', '{runNode}'].every(v => ordered(row, v, '<TrimChip />')))
  check('the deck keeps its own chip when it owns the vitals (the frame yields)', row.includes('{!deckOwnsVitals ? <TrimChip /> : null}') && read('src/components/DeckPane.tsx').includes('<TrimChip />'))
}

console.log('§2 SSR-07 — the waiting-words sentence stays dead (pen poison)')
{
  const bar = read('src/components/SwitchboardTagBar.tsx')
  check('POISON: no waiting-words sentence on the tag bar', !bar.includes('waiting for') && !bar.includes('waitingWords'))
}

console.log('§3 SSR-06 — run capsule truncation: cells + ellipsis, fitting lines untouched')
{
  const { buildRunCapsuleLine } = await import('../../src/commands/run/runInspectorModel.ts')
  const { stringWidth } = await import('../../src/ink/stringWidth.ts')
  const snap = (blocker: string | null, nextAction = ''): Record<string, unknown> => ({
    schema: 1, runId: 'r', owner: 'o', rootMessageId: null, objective: '', startedAt: 0, updatedAt: 0,
    lifecycle: 'active', substantive: true, phase: 'build', phaseReason: '', deliverables: [],
    lastAction: '', nextAction, blocker: blocker === null ? null : { description: blocker },
    changedPaths: [], totalChangedPaths: 0, recentEffects: [], pendingTools: [], unresolvedBadEffects: 0,
  })
  const wide = '门'.repeat(60)
  const cut = buildRunCapsuleLine(snap(wide) as never, 0) ?? ''
  const blocked = cut.split(' · ').find(p => p.startsWith('BLOCKED: ')) ?? ''
  const payload = blocked.slice('BLOCKED: '.length)
  check('a wide blocker cuts by CELLS within its 40 budget', stringWidth(payload) <= 40, `w=${stringWidth(payload)}`)
  check('the cut ends with the ellipsis (never a silent chop)', payload.endsWith('…'))
  const short = buildRunCapsuleLine(snap('stuck on the lockfile') as never, 0) ?? ''
  check('a fitting blocker is byte-identical (no ellipsis, no cut)', short.includes('BLOCKED: stuck on the lockfile'))
  const next = buildRunCapsuleLine(snap(null, 'x'.repeat(80)) as never, 0) ?? ''
  const nextPart = next.split(' · ').find(p => p.startsWith('next: ')) ?? ''
  check('nextAction rides the same law at its 48 budget', stringWidth(nextPart.slice('next: '.length)) <= 48 && nextPart.endsWith('…'))
}

process.exit(failures === 0 ? 0 : 1)
