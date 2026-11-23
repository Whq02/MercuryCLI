import { getShortcutDisplay } from '../keys/shortcutFormat.js'

export function ctrlOToExpand(): string {
  return `(${getShortcutDisplay('app:toggleTranscript', 'Global', 'ctrl+o')} to expand)`
}
