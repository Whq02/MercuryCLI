
import { basename } from 'node:path'
import { bumpHelmLanesVersion } from '../cockpit/helmFocus.js'
import { isTabulaEnabled } from './tabulaGates.js'
import { appendEvents, materializeNotepad, type TabulaEvent } from './tabulaStore.js'

export interface ArmedNote {
  id: string
  insertedText: string
  dir: string
  projectName: string
  armedAt: number
}

let armed: ArmedNote[] = []
let inFlight: ArmedNote[] = []

const ARM_CAP = 5

export function resetTabulaFireTrackerForTest(): void {
  armed = []
  inFlight = []
}

export function armNoteFire(entry: {
  id: string
  insertedText: string
  dir: string
  projectName: string
}): void {
  if (!isTabulaEnabled()) return
  const text = entry.insertedText.trim()
  if (!text) return
  armed = armed.filter(a => a.id !== entry.id)
  armed.push({ ...entry, insertedText: text, armedAt: Date.now() })
  if (armed.length > ARM_CAP) armed = armed.slice(-ARM_CAP)
}

function appendPerDir(
  entries: ArmedNote[],
  toEvents: (batch: ArmedNote[]) => TabulaEvent[],
): void {
  const byDir = new Map<string, ArmedNote[]>()
  for (const e of entries) {
    const batch = byDir.get(e.dir) ?? []
    batch.push(e)
    byDir.set(e.dir, batch)
  }
  for (const [dir, batch] of byDir) {
    appendEvents(dir, toEvents(batch))
    materializeNotepad(dir, batch[0]?.projectName || basename(dir) || 'project')
  }
  if (byDir.size > 0) bumpHelmLanesVersion()
}

export function tabulaOnPromptSubmit(prompt: string): void {
  inFlight = []
  if (!isTabulaEnabled() || armed.length === 0) return
  const p = typeof prompt === 'string' ? prompt : ''
  if (!p.trim()) return
  const matched = armed.filter(a => p.includes(a.insertedText))
  if (matched.length === 0) return
  armed = armed.filter(a => !matched.includes(a))
  const stamp = new Date().toISOString()
  appendPerDir(matched, batch => batch.map(a => ({ t: stamp, op: 'fire' as const, id: a.id })))
  inFlight = matched
}

export function tabulaOnTurnStop(): void {
  if (inFlight.length === 0) return
  const settled = inFlight
  inFlight = []
  if (!isTabulaEnabled()) return
  const stamp = new Date().toISOString()
  appendPerDir(settled, batch =>
    batch.map(a => ({ t: stamp, op: 'done' as const, id: a.id, done: true, via: 'auto' as const })),
  )
}
