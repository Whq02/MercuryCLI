import * as React from 'react'
import {
  CONFIG_POPUP_HINT,
  CONFIG_POPUP_ROWS,
  CONFIG_POPUP_WIDTH,
  Config,
  configPopupFolder,
} from '../../components/Settings/Config.js'
import { useSettingsPopupFrame } from '../../components/Settings/Settings.js'
import type { LocalCommandResult, LocalJSXCommandContext } from '../../types/command.js'
import { openSettingsPopup, type SettingsPopupGeometry, type SettingsPopupRequest } from '../../utils/cockpit/settingsPopup.js'

export function ConfigPopupBody({ geometry, context }: { geometry: SettingsPopupGeometry; context: LocalJSXCommandContext }): React.ReactNode {
  const frame = useSettingsPopupFrame()
  return (
    <Config
      onClose={result => frame.close(typeof result === 'string' ? result : undefined)}
      onLine={frame.setLine}
      onOwnsEscape={frame.setOwnsEscape}
      context={context}
      width={geometry.inner}
      contentHeight={geometry.rowBudget}
    />
  )
}

export function configPopupRequest(context: LocalJSXCommandContext): SettingsPopupRequest {
  return {
    view: 'config',
    width: CONFIG_POPUP_WIDTH,
    rows: CONFIG_POPUP_ROWS,
    line: configPopupFolder(),
    hint: CONFIG_POPUP_HINT,
    body: geometry => <ConfigPopupBody geometry={geometry} context={context} />,
  }
}

export const call = async (_args: string, context: LocalJSXCommandContext): Promise<LocalCommandResult> => {
  openSettingsPopup(configPopupRequest(context))
  return { type: 'skip' }
}
