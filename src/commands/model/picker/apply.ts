import { crossProviderNote, providerFamilyOfSetting, settleModelSelection, type SeatReceiptState } from '../../../models/catalogue/modelTransition.js'
import { previewForSelection, transitionPlanSummary } from '../../../models/roads/transitionPreview.js'
import { persistModelChoice } from '../persistModelChoice.js'
import type { EngineConnectorV1 } from '../../../engine/connector/types.js'
import { noteModelUse } from './rows.js'
import type { PickRoad, PickContext } from './select.js'

export function applyOnSeat({ onDone, labelOf, flipDoorNote }: PickContext, focused: EngineConnectorV1, value: string, id: string, pick: PickRoad, seated?: (state: SeatReceiptState) => void): void {
  const label = labelOf(id)
  const factsBefore = focused.modelFacts()
  const messagesBefore = [...focused.records()]
  const choice = persistModelChoice(value)
  void focused.setModel(value, undefined, choice.replacedDefault ?? undefined).then(receipt => {
    if (receipt.state === 'refused') {
      choice.restore()
      onDone(`The model switch was refused: ${receipt.detail}`)
      return
    }
    const slotNote = flipDoorNote(pick)
    const saved = choice.sentence
    if (receipt.state === 'no-op') {
      onDone(saved === '' && slotNote === '' ? `Already on ${label} — nothing to change` : `Already on ${label}${saved}${slotNote}`)
      seated?.(receipt.state)
      return
    }
    noteModelUse(value, pick.door)
    const doorCross = providerFamilyOfSetting(factsBefore.effective) !== providerFamilyOfSetting(value) ? crossProviderNote(value) : ''
    const plan = previewForSelection(messagesBefore, factsBefore.effective, value)
    const lossNote = transitionPlanSummary(plan)
    onDone(
      receipt.state === 'queued'
        ? `Model switch queued: ${label}${saved} — applies when this session's turn settles (the running turn keeps its model)${doorCross}${lossNote}${slotNote}`
        : `Set model to ${label}${saved} — this session's next message runs it${receipt.note !== undefined ? ` (${receipt.note})` : ''}${doorCross}${lossNote}${slotNote}`,
    )
    seated?.(receipt.state)
  })
}

export function applyLocally({ messages, onDone, store, setAppState, labelOf, flipDoorNote }: PickContext, value: string, id: string, pick: PickRoad): void {
  const label = labelOf(id)
  const stateNow = store.getState()
  const settled = settleModelSelection(stateNow, value, {
    turnActive: stateNow.foregroundTurnActive || stateNow.pendingModelSwitch !== null,
  })
  const slotNote = flipDoorNote(pick)
  const saved = persistModelChoice(value).sentence
  if (settled.kind === 'no-op') {
    onDone(saved === '' && slotNote === '' ? `Already on ${label} — nothing to change` : `Already on ${label}${saved}${slotNote}`)
    return
  }
  noteModelUse(value, pick.door)
  if (settled.kind === 'cancelled-pending') {
    setAppState(prev => ({ ...prev, ...settled.patch }))
    onDone(`Already on ${label} — queued switch cancelled${saved}${slotNote}`)
    return
  }
  const effectiveFrom = stateNow.engineModelForSession ?? stateNow.engineModel
  const plan = previewForSelection(messages, effectiveFrom, value)
  const lossNote = transitionPlanSummary(plan)
  if (settled.kind === 'queued') {
    setAppState(prev => ({ ...prev, ...settled.patch }))
    onDone(
      `Model switch queued: ${label}${saved} — applies when the current turn settles (the running turn keeps its model)${settled.crossProvider ? crossProviderNote(value) : ''}${lossNote}${slotNote}`,
    )
    return
  }
  setAppState(prev => ({ ...prev, ...settled.patch }))
  onDone(
    `Set model to ${label}${saved}${settled.receipt.crossProvider ? crossProviderNote(value) : ''}${lossNote}${slotNote}`,
  )
}
