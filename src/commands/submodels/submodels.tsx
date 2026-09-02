import * as React from 'react'
import { CommandCenter } from '../../components/mercury-ui/components.js'
import { SubModelPicker, type SubModelRoutePick } from '../../components/SubModelPicker.js'
import { setSubModel, type SubModelContainer } from '../../utils/model/subModelSlots.js'
import type { LocalJSXCommandCall, LocalJSXCommandOnDone } from '../../types/command.js'


let parkedPick: { container: SubModelContainer; modelId: string } | null = null

function SubModelsSurface({
  onDone,
  initialContainer,
  initialNote,
  initialModelId,
}: {
  onDone: LocalJSXCommandOnDone
  initialContainer: SubModelContainer
  initialNote?: string
  initialModelId?: string
}): React.ReactNode {
  const close = (): void => onDone(undefined, { display: 'skip' })
  const route = (pick: SubModelRoutePick, note: string): void => {
    if (pick.modelId !== '') {
      parkedPick = { container: pick.container, modelId: pick.modelId }
    }
    onDone(note, {
      display: 'system',
      nextInput: `${pick.command} --return=/submodels`,
      submitNextInput: true,
    })
  }
  return (
    <CommandCenter
      view="submodels"
      subtitle="the Minerva & Console models"
      footer="↑↓ browse · ↵ select / sign in · tab container · esc close"
      onClose={close}
      captureInput={false}
      closeKeys="esc"
    >
      <SubModelPicker
        onClose={close}
        onRoute={route}
        initialContainer={initialContainer}
        {...(initialNote !== undefined ? { initialNote } : {})}
        {...(initialModelId !== undefined ? { initialModelId } : {})}
      />
    </CommandCenter>
  )
}

export const call: LocalJSXCommandCall = async (onDone, _context) => {
  const parked = parkedPick
  parkedPick = null
  let initialContainer: SubModelContainer = 'minerva'
  let initialNote: string | undefined
  let initialModelId: string | undefined
  if (parked !== null) {
    const applied = setSubModel(parked.container, parked.modelId)
    initialContainer = parked.container
    initialNote = applied.ok ? applied.receipt : applied.reason
    initialModelId = parked.modelId
  }
  return (
    <SubModelsSurface
      onDone={onDone}
      initialContainer={initialContainer}
      {...(initialNote !== undefined ? { initialNote } : {})}
      {...(initialModelId !== undefined ? { initialModelId } : {})}
    />
  )
}
