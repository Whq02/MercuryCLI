import * as React from 'react'
import { JEV_POPUP_HINT, JEV_POPUP_WIDTH, Jev, jevPopupLine } from '../../components/Settings/Jev.js'
import { useSettingsPopupFrame } from '../../components/Settings/Settings.js'
import type { LocalCommandResult, LocalJSXCommandContext } from '../../types/command.js'
import { openSettingsPopup, type SettingsPopupGeometry, type SettingsPopupRequest } from '../../utils/cockpit/settingsPopup.js'

export function JevPopupBody({ geometry }: { geometry: SettingsPopupGeometry }): React.ReactNode {
  const frame = useSettingsPopupFrame()
  return <Jev width={geometry.inner} rowBudget={geometry.rowBudget} onLine={frame.setLine} onOwnsEscape={frame.setOwnsEscape} />
}

export function jevPopupRequest(): SettingsPopupRequest {
  return {
    view: 'jev',
    width: JEV_POPUP_WIDTH,
    rows: null,
    line: jevPopupLine(),
    hint: JEV_POPUP_HINT,
    body: geometry => <JevPopupBody geometry={geometry} />,
  }
}

export const call = async (_args: string, _context: LocalJSXCommandContext): Promise<LocalCommandResult> => {
  openSettingsPopup(jevPopupRequest())
  return { type: 'skip' }
}
