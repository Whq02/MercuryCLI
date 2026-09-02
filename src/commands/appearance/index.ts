import type { Command } from '../../commands.js'
import { currentStoredThemeSetting } from '../../components/design-system/ThemeProvider.js'

// /appearance — the unified appearance center: theme
// (the ONE canonical picker, live preview), the identity accent, and motion,
// in one place. The old /theme pane was removed — this is
// the ONE theme entry point; /accent stays a direct deep link.
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
