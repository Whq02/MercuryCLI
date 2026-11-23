import { nextSettingsOpen } from '../../screen/settings/Settings.js'
import { Usage } from '../../screen/settings/Usage.js'
import { usagePopupLine } from '../../screen/settings/usageLine.js'
import type { LocalCommandResult, LocalJSXCommandContext } from '../catalogue/command.js'
import { openSettingsPopup } from '../../screen/cockpit/settingsPopup.js'

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
