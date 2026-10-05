import * as React from 'react'
import { nextSettingsOpen } from '../../components/Settings/Settings.js'
import { Usage } from '../../components/Settings/Usage.js'
import { usagePopupLine } from '../../components/Settings/usageLine.js'
import type { LocalCommandResult, LocalJSXCommandContext } from '../../types/command.js'
import { openSettingsPopup } from '../../utils/cockpit/settingsPopup.js'

export const call = async (_args: string, _context: LocalJSXCommandContext): Promise<LocalCommandResult> => {
  const openToken = nextSettingsOpen()
  openSettingsPopup({
    view: 'usage',
    width: hostColumns => Math.min(150, hostColumns),
    rows: 29,
    line: usagePopupLine(),
    hint: '↑↓ scroll · esc or click outside closes',
    body: geometry => <Usage key={openToken} openToken={openToken} width={geometry.inner} rowBudget={geometry.rowBudget} compact={geometry.compact} />,
  })
  return { type: 'skip' }
}
