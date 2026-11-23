#!/usr/bin/env bun


let failures = 0
const check = (name: string, ok: boolean, detail?: string): void => {
  if (ok) {
    console.log(`  ok  ${name}`)
  } else {
    failures++
    console.error(`  RED ${name}${detail ? ` — ${detail}` : ''}`)
  }
}


console.log('§3 SSR-06 — run capsule truncation: cells + ellipsis, fitting lines untouched')
{
  const { buildRunCapsuleLine } = await import('../../src/commands/run/runInspectorModel.ts')
  const { stringWidth } = await import('../../src/screen/renderer/stringWidth.ts')
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
  check('a wide blocker cuts by CELLS within its 40 budget', stringWidth(payload) <= 40, `w=${stringWidth(payload)}; change buildRunCapsuleLine in src/commands/run/runInspectorModel.ts to cut the BLOCKED text by cells (stringWidth) within 40`)
  check('the cut ends with the ellipsis (never a silent chop)', payload.endsWith('…'), 'change buildRunCapsuleLine in src/commands/run/runInspectorModel.ts so a cut BLOCKED text ends with the ellipsis')
  const short = buildRunCapsuleLine(snap('stuck on the lockfile') as never, 0) ?? ''
  check('a fitting blocker is byte-identical (no ellipsis, no cut)', short.includes('BLOCKED: stuck on the lockfile'), 'change buildRunCapsuleLine in src/commands/run/runInspectorModel.ts so a blocker that fits is left uncut')
  const next = buildRunCapsuleLine(snap(null, 'x'.repeat(80)) as never, 0) ?? ''
  const nextPart = next.split(' · ').find(p => p.startsWith('next: ')) ?? ''
  check('nextAction rides the same law at its 48 budget', stringWidth(nextPart.slice('next: '.length)) <= 48 && nextPart.endsWith('…'), `change buildRunCapsuleLine in src/commands/run/runInspectorModel.ts to cut the next text by cells within 48 and end it with the ellipsis; part: ${nextPart}`)
}

process.exit(failures === 0 ? 0 : 1)
