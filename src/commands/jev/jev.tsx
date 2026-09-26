import * as React from 'react'
import { jevReceiptWords, setJevEnabled } from '../../services/jev/jevSetting.js'
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

export const call = async (args: string, _context: LocalJSXCommandContext): Promise<LocalCommandResult> => {
  const words = args.trim().split(/\s+/).join(' ')
  if (words === '') {
    openSettingsPopup(jevPopupRequest())
    return { type: 'skip' }
  }
  if (words === 'on' || words === 'off') return { type: 'text', value: jevReceiptWords(setJevEnabled(words === 'on', 'official')) }
  return { type: 'text', value: 'Use /jev on or /jev off for the official road. Bare /jev opens the card; /jevor on selects OpenRouter.' }
}
