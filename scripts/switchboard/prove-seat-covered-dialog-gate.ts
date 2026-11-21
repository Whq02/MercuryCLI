#!/usr/bin/env bun

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}


{
  const { askBuilder, mountPart } = await import('../ui/chatScenarios.ts')
  const { useChatAsksCard } = await import('../../src/screens/chat/useChatAsks.tsx')
  const head = (await askBuilder())('toolu_gate', 'touch gate.txt', process.cwd(), () => {}).confirm
  const drawnWhen = async (chatSurfaceCovered: boolean): Promise<boolean> => {
    const card = await mountPart(() => useChatAsksCard({ focusedInputDialog: 'tool-permission', repinToBottom: () => {}, toolUseConfirmQueue: [head], resolvedConsentCount: 0, resolveHeadPermission: () => {}, chatSurfaceCovered, verbose: false }))
    const drawn = card.value().permissionOverlay !== null
    card.unmount()
    return drawn
  }
  const uncovered = await drawnWhen(false)
  const covered = await drawnWhen(true)
  check('G2 the permission overlay render requires !chatSurfaceCovered', uncovered && !covered, `drawn uncovered ${uncovered} · drawn covered ${covered}`)
}

{
  const { openSelectorPart } = await import('../ui/chatScenarios.ts')
  const selector = await openSelectorPart('seat-covered-selector', { keepHome: true })
  const uncovered = selector.part.value().messageSelector !== null
  await selector.plant({ chatSurfaceCovered: true })
  const covered = selector.part.value().messageSelector !== null
  await selector.close()
  check('G3 the message selector render requires !chatSurfaceCovered', uncovered && !covered, `drawn uncovered ${uncovered} · drawn covered ${covered}`)
}

{
  const { openDialogsPart } = await import('../ui/chatScenarios.ts')
  const dialogs = await openDialogsPart('seat-covered-dialogs', { keepHome: true })
  await dialogs.plant({ focusedInputDialog: 'cost-threshold' })
  const uncovered = dialogs.part.value().focusedBottomDialog !== null
  await dialogs.plant({ chatSurfaceCovered: true })
  const covered = dialogs.part.value().focusedBottomDialog !== null
  await dialogs.close()
  check('G4 the bottom dialogs are null when covered', uncovered && !covered, `drawn uncovered ${uncovered} · drawn covered ${covered}`)
}


console.log(failures === 0 ? '\nprove-seat-covered-dialog-gate: ALL LAWS HOLD' : `\nprove-seat-covered-dialog-gate: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
