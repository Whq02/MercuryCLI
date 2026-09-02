import { basename, join } from 'node:path'
import { getOriginalCwd } from '../../bootstrap/state.js'
import type { LocalCommandCall } from '../../types/command.js'
import { isTabulaEnabled, tabulaProjectDir } from '../../utils/tabula/tabulaGates.js'
import { runMinervaMessage } from '../../utils/tabula/minerva.js'

// `/minerva <message>` — the notepad chat, from anywhere. One billed call of
// the Minerva model per invocation (typing the command IS the consent);
// Minerva turns the message into structured note ops (add / done / pri /
// refine — never delete) on the project notepad journal. The notepad's face
// is its plain file on disk; the /tabula surface is Minerva's room, where
// Minerva refines your saved prompts instead.
export const call: LocalCommandCall = async args => {
  if (!isTabulaEnabled()) {
    return { type: 'text', value: 'The notepad is off this session (MERCURY_TABULA=0) — nothing sent.' }
  }
  const message = (args ?? '').trim()
  const cwd = getOriginalCwd()
  const dir = tabulaProjectDir(cwd)
  const notepad = join(dir, 'notepad.md')
  if (!message) {
    return {
      type: 'text',
      value: `Usage: \`/minerva <message>\` — e.g. \`/minerva need to fix the flaky gate, and the cache thing is done\`. One billed Minerva call (model: /submodels); notes land in ${notepad}.`,
    }
  }
  const res = await runMinervaMessage(dir, basename(cwd) || 'project', message, { projectPath: cwd })
  if (!res.ran) return { type: 'text', value: `Minerva skipped — ${res.reason}.` }
  if (!res.ok) return { type: 'text', value: `Minerva refused — ${res.reason} (nothing changed; notepad: ${notepad}).` }
  const counts = [
    res.added ? `${res.added} added` : '',
    res.closed ? `${res.closed} closed` : '',
    res.repri ? `${res.repri} re-prioritized` : '',
    res.refined ? `${res.refined} refined` : '',
  ]
    .filter(Boolean)
    .join(' · ')
  return {
    type: 'text',
    value: `Minerva: ${res.reply}${counts ? `  (${counts})` : ''}  — notepad: ${notepad}`,
  }
}
