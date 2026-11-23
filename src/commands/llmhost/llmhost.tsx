import * as React from 'react'
import { LlmHostDialog } from './LlmHostDialog.js'
import { useSettingsPopupFrame } from '../../screen/settings/Settings.js'
import type { LlmHostRoad } from '../../models/llm-host/index.js'
import { runHostedModel } from '../../models/hosting/index.js'
import type { LocalCommandResult } from '../catalogue/command.js'
import { openSettingsPopup, type SettingsPopupGeometry, type SettingsPopupRequest } from '../../screen/cockpit/settingsPopup.js'
import { LLM_HOST_WORDS } from './words.js'

export function LlmHostPopupBody({ geometry, road }: { geometry: SettingsPopupGeometry; road?: LlmHostRoad }): React.ReactNode {
  const frame = useSettingsPopupFrame()
  return <LlmHostDialog width={geometry.inner} rowBudget={geometry.rowBudget} road={road ?? runHostedModel} onLine={frame.setLine} onHint={frame.setHint} onOwnsEscape={frame.setOwnsEscape} onClose={frame.close} />
}

export function llmHostPopupRequest(road?: LlmHostRoad): SettingsPopupRequest {
  return {
    view: 'llmhost',
    width: hostColumns => hostColumns,
    rows: 33,
    line: LLM_HOST_WORDS.opening,
    hint: LLM_HOST_WORDS.hint,
    bodyOwnsEscape: true,
    body: geometry => <LlmHostPopupBody geometry={geometry} road={road} />,
  }
}

export const call = async (): Promise<LocalCommandResult> => {
  openSettingsPopup(llmHostPopupRequest())
  return { type: 'skip' }
}
