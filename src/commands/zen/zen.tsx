import type * as React from 'react'
import type { LocalJSXCommandContext, LocalJSXCommandOnDone } from '../../types/command.js'
import { setZenMode, zenModeOn } from '../../utils/cockpit/zenMode.js'

export const ZEN_WORDS = ['on', 'off'] as const

export type ZenCommandResult = {
  message: string
  zen?: boolean
}

export function executeZen(args: string): ZenCommandResult {
  const word = args.trim()
  const token = word.toLowerCase()
  const on = zenModeOn()
  if (token !== '' && !(ZEN_WORDS as readonly string[]).includes(token)) {
    return { message: `Valid options: ${ZEN_WORDS.join('|')} — "${word}" is not a zen option.` }
  }
  const next = token === '' ? !on : token === 'on'
  if (next === on) return { message: `zen is already ${on ? 'on' : 'off'}` }
  const error = setZenMode(next)
  if (error !== null) return { message: `Could not save the zen setting: ${error.message}` }
  return { message: next ? 'zen on — rails hidden · saved for later boots' : 'zen off — rails back · saved for later boots', zen: next }
}

export async function call(
  onDone: LocalJSXCommandOnDone,
  _context: LocalJSXCommandContext,
  args: string,
): Promise<React.ReactNode> {
  onDone(executeZen(args).message)
  return null
}
