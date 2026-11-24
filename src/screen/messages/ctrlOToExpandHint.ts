import { getShortcutDisplay } from '../keys/shortcutFormat.js'

export function ctrlOToExpandHint(): string {
  return `(${getShortcutDisplay('app:toggleTranscript', 'Global', 'ctrl+o')} to expand)`
}
