import instances from '../../ink/instances.js'
import type {
  LocalCommandResult,
  LocalJSXCommandContext,
} from '../../types/command.js'

// ============================================================================
// commands/mouse/mouse.ts — `/mouse [on|off]` (uniqueness-program P8).
// ----------------------------------------------------------------------------
// While SGR mouse tracking is on (the fullscreen default — it powers the
// clickable TUI), the TERMINAL's own drag-select/copy is dead in most
// emulators, which surfaces as "I can't copy from the REPL". The in-app
// selection (drag + ctrl+c, ink/selection.ts) covers most copying; this
// command is the ESCAPE HATCH for everything else: `/mouse off` hands the
// pointer back to the terminal (native select/copy works, TUI clicks stop),
// `/mouse on` (or plain `/mouse` to toggle back) restores the clickable TUI.
// Session-scoped; a fullscreen re-entry resets to the default (on).
// ============================================================================

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
  return {
    type: 'text',
    value: next
      ? 'mouse capture ON — clickable TUI (rails · tabs · cards); in-app drag-copy is transcript-scoped (rails never pollute the clipboard)'
      : 'mouse capture OFF — native terminal select/copy works now (NOTE: native selection sweeps the side rails; /mouse on + drag copies the transcript cleanly); TUI clicks/wheel are off until /mouse on — the statusbar shows an amber chip while off',
  }
}
