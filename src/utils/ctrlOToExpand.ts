import { getShortcutDisplay } from '../keybindings/shortcutFormat.js'

export function ctrlOToExpand(): string {
  return `(${getShortcutDisplay('app:toggleTranscript', 'Global', 'ctrl+o')} to expand)`
}
