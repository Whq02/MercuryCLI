import { PromptsPanel } from '../../screen/prompts-panel/PromptsPanel.js'
import type { LocalJSXCommandCall } from '../catalogue/command.js'
import { CommandPopupLease } from '../../screen/overlays/CommandPopupSlot.js'
import { claimCommandPopup } from '../../screen/cockpit/commandPopup.js'
import { CREW_POPUP_WIDE, crewDoorShape } from '../../screen/fullscreen-layout/CrewViewSlot.js'

export const call: LocalJSXCommandCall = async onDone => {
  const token = claimCommandPopup(crewDoorShape('prompts', CREW_POPUP_WIDE))
  return (
    <CommandPopupLease token={token}>
      <PromptsPanel
        onClose={(nextInput?: string) =>
          nextInput !== undefined && nextInput.trim().length > 0
            ? onDone(undefined, { display: 'skip', nextInput })
            : onDone(undefined, { display: 'skip' })
        }
      />
    </CommandPopupLease>
  )
}
