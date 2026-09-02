
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { getMercuryHome } from '../utils/envUtils.js'
import { logForDebugging } from '../utils/debug.js'

export interface BootNote {
  kind: 'info' | 'warn'
  text: string
  when: number
}

const notes: BootNote[] = []
const MAX_NOTES = 16

export function addBootNote(kind: BootNote['kind'], text: string): void {
  if (notes.length >= MAX_NOTES) return
  notes.push({ kind, text: text.slice(0, 200), when: Date.now() })
  logForDebugging(`[boot-note:${kind}] ${text}`)
}

export function bootNotes(): readonly BootNote[] {
  return notes
}

export function launcherNotesPath(configHome: string = getMercuryHome()): string {
  return join(configHome, 'boot-notes.json')
}

export function collectLauncherNotes(configHome: string = getMercuryHome()): void {
  const path = launcherNotesPath(configHome)
  try {
    if (!existsSync(path)) return
    const raw = JSON.parse(readFileSync(path, 'utf8')) as {
      notes?: { kind?: string; text?: string }[]
    }
    for (const n of raw.notes ?? []) {
      if (typeof n.text === 'string' && n.text.trim()) {
        addBootNote(n.kind === 'warn' ? 'warn' : 'info', n.text.trim())
      }
    }
  } catch (err) {
    logForDebugging(`[boot-note] launcher notes unreadable: ${String(err)}`)
  } finally {
    try {
      rmSync(path, { force: true })
    } catch {
    }
  }
}

export function _resetBootNotesForTesting(): void {
  notes.length = 0
}
