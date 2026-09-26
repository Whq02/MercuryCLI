import { jevReceiptWords, setJevEnabled } from '../../services/jev/jevSetting.js'
import type { LocalCommandResult, LocalJSXCommandContext } from '../../types/command.js'

export const call = async (args: string, _context: LocalJSXCommandContext): Promise<LocalCommandResult> => {
  const word = args.trim()
  if (word === 'on' || word === 'off') return { type: 'text', value: jevReceiptWords(setJevEnabled(word === 'on', 'openrouter')) }
  return { type: 'text', value: 'Use /jevor on or /jevor off. /jev opens the card; /jev on selects the official road.' }
}
