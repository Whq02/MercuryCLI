import type { Command } from '../../commands.js'
import { currentStoredThemeSetting } from '../../components/design-system/ThemeProvider.js'

const appearance = {
  type: 'local-jsx',
  name: 'appearance',
  description: 'Appearance — theme, accent, and motion in one place',
  currentValue: () => currentStoredThemeSetting(),
  isEnabled: () => true,
  isHidden: false,
  load: () => import('./appearance.js'),
} satisfies Command

export default appearance
