#!/usr/bin/env bun

let failures = 0
function check(label: string, cond: boolean, detail = '', hint = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}${!cond && hint ? ` — ${hint}` : ''}`)
}


{
  const { askBuilder, mountPart } = await import('../ui/chatScenarios.ts')
  const { useChatAsksCard } = await import('../../src/screen/chat/useChatAsks.tsx')
  const head = (await askBuilder())('toolu_gate', 'touch gate.txt', process.cwd(), () => {}).confirm
  const drawnWhen = async (chatSurfaceCovered: boolean): Promise<boolean> => {
    const card = await mountPart(() => useChatAsksCard({ focusedInputDialog: 'tool-permission', repinToBottom: () => {}, toolUseConfirmQueue: [head], resolvedConsentCount: 0, resolveHeadPermission: () => {}, chatSurfaceCovered, verbose: false }))
    const drawn = card.value().permissionOverlay !== null
    card.unmount()
    return drawn
  }
  const uncovered = await drawnWhen(false)
  const covered = await drawnWhen(true)
  check('G2 the permission overlay render requires !chatSurfaceCovered', uncovered && !covered, `drawn uncovered ${uncovered} · drawn covered ${covered}`, 'in src/screen/chat/useChatAsks.tsx, useChatAsksCard must build permissionOverlay only when focusedInputDialog is tool-permission, the queue has a head and chatSurfaceCovered is false')
}

{
  const { openSelectorPart } = await import('../ui/chatScenarios.ts')
  const selector = await openSelectorPart('seat-covered-selector', { keepHome: true })
  const uncovered = selector.part.value().rewindPicker !== null
  await selector.plant({ chatSurfaceCovered: true })
  const covered = selector.part.value().rewindPicker !== null
  await selector.close()
  check('G3 the message selector render requires !chatSurfaceCovered', uncovered && !covered, `drawn uncovered ${uncovered} · drawn covered ${covered}`, 'in src/screen/chat/useChatRewindPicker.tsx, useChatRewindPickerView must build messageSelector only while chatSurfaceCovered is false')
}

{
  const { openDialogsPart } = await import('../ui/chatScenarios.ts')
  const dialogs = await openDialogsPart('seat-covered-dialogs', { keepHome: true })
  await dialogs.plant({ focusedInputDialog: 'cost-threshold' })
  const uncovered = dialogs.part.value().focusedBottomDialog !== null
  await dialogs.plant({ chatSurfaceCovered: true })
  const covered = dialogs.part.value().focusedBottomDialog !== null
  await dialogs.close()
  check('G4 the bottom dialogs are null when covered', uncovered && !covered, `drawn uncovered ${uncovered} · drawn covered ${covered}`, 'in src/screen/chat/useChatDialogs.tsx, useChatDialogsView must return null for focusedBottomDialog when chatSurfaceCovered is true and draw the cost-threshold dialog when it is false')
}


console.log(failures === 0 ? '\nprove-seat-covered-dialog-gate: ALL LAWS HOLD' : `\nprove-seat-covered-dialog-gate: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
