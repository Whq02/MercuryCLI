import type { Command } from '../catalogue/commands.js'
import { currentStoredThemeSetting } from '../../screen/theme/ThemeProvider.js'

const appearance = {
  type: 'local-jsx',
  name: 'appearance',
  description: 'Appearance — theme, accent, and motion in one place',
  argumentHint: '[accent <name|#hex|reset>]',
  currentValue: () => currentStoredThemeSetting(),
  isEnabled: () => true,
  isHidden: false,
  load: () => import('./appearance.js'),
} satisfies Command

export default appearance
