import * as React from 'react'
import { CommandCenter } from '../../components/mercury-ui/components.js'
import { SubModelPicker, type SubModelRoutePick } from '../../components/SubModelPicker.js'
import { setSubModel, type SubModelContainer } from '../../utils/model/subModelSlots.js'
import type { LocalJSXCommandCall, LocalJSXCommandOnDone } from '../../types/command.js'

// ============================================================================
//  /submodels — the picker for the two SUB-model containers. A signed-out
//  pick closes this surface, submits the family's attach command with
//  `--return=/submodels` chained, and parks the pick HERE; when the attach
//  surface settles, the chained /submodels re-opens, applies the parked pick
//  through the one validated writer, and paints the receipt with the cursor
//  on the same row — the operator never re-navigates. A pick whose family
//  still holds no credential re-parks nothing: the row answers with its
//  honest state instead.
// ============================================================================

/** The pick parked across a route-out to an attach surface. Module state:
 *  the round trip stays inside one process, and an abandoned park is
 *  harmless — consuming it re-validates through setSubModel. */
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
      footer="↑↓ browse · ↵ select / sign in · e effort · tab container · esc close"
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
  // The parked pick lands FIRST (the return leg of a routed sign-in):
  // apply through the one validated writer and seed the picker with the
  // receipt — or with the row's still-honest refusal when the credential
  // never arrived. Either way the cursor opens on that container.
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
