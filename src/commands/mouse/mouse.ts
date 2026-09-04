import instances from '../../ink/instances.js'
import type {
  LocalCommandResult,
  LocalJSXCommandContext,
} from '../../types/command.js'
import { saveGlobalConfig } from '../../utils/config.js'


export const call = async (
  rawArg: string,
  _context: LocalJSXCommandContext,
): Promise<LocalCommandResult> => {
  const ink = instances.get(process.stdout)
  if (!ink || typeof ink.setMouseTrackingEnabled !== 'function') {
    return {
      type: 'text',
      value: 'mouse capture is only toggleable in the fullscreen TUI',
    }
  }
  const arg = rawArg.trim().toLowerCase()
  const current = ink.isMouseTrackingEnabled()
  const next = arg === 'on' ? true : arg === 'off' ? false : !current
  if (next === current) {
    return {
      type: 'text',
      value: `mouse capture already ${current ? 'on' : 'off'}`,
    }
  }
  ink.setMouseTrackingEnabled(next)
  saveGlobalConfig(current => ({ ...current, mouseCapture: next }))
  return {
    type: 'text',
    value: next
      ? 'mouse capture ON — clickable TUI (rails · tabs · cards); in-app drag-copy is transcript-scoped (rails never pollute the clipboard); saved for later boots'
      : 'mouse capture OFF — native terminal select/copy works now (NOTE: native selection sweeps the side rails; /mouse on + drag copies the transcript cleanly); TUI clicks/wheel are off until /mouse on — the statusbar shows an amber chip while off; saved for later boots (/config → Mouse capture shows it)',
  }
}
