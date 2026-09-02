import { mkdirSync } from 'node:fs'
import { logForDebugging } from '../utils/debug.js'
import { getProjectDir } from '../utils/sessionStorage/paths.js'
import { appendSessionReceipt } from '../services/switchboard/sessionReceipts.js'
import { updateConcourseWorkers } from './concourseSupervisor.js'
import {
  applyKitEdit,
  cloneSessionKit,
  materializedKitForWorkspace,
  setSessionKit,
  type SessionKitEditV1,
} from './sessionKit.js'

export type KitOpOutcome = { outcome: 'applied' | 'noop' | 'refused'; detail?: string }

function describeEdit(edit: SessionKitEditV1): string {
  const words: string[] = []
  for (const dial of edit.mcp ?? []) words.push(`mcp ${dial.name} ${dial.on ? 'on' : 'off'}`)
  for (const dial of edit.skills ?? []) words.push(`skill ${dial.name} ${dial.state}`)
  for (const dial of edit.extensions ?? []) words.push(`extension ${dial.name} ${dial.on ? 'on' : 'off'}`)
  return words.join(' · ')
}

export function applyConcourseKitOp(sessionId: string, edit: SessionKitEditV1, by: string, dir?: string): KitOpOutcome {
  let out: KitOpOutcome = {
    outcome: 'refused',
    detail: 'unknown-session: no live worker record owns this session',
  }
  updateConcourseWorkers(workers => {
    const rec = Object.values(workers).find(r => r.sessionId === sessionId && r.endedAt === undefined)
    if (!rec) return
    const materialized = rec.kit === undefined
    const standing = rec.kit ?? materializedKitForWorkspace(rec.workspaceId)
    const next = applyKitEdit(standing, edit)
    if (next === standing && !materialized) {
      out = { outcome: 'noop', detail: `the kit already reads so (${describeEdit(edit)})` }
      return
    }
    setSessionKit(rec, next === standing ? cloneSessionKit(standing) : next)
    out = {
      outcome: 'applied',
      detail: `${describeEdit(edit)}${materialized ? " — the kit was materialized from this session's whole-config reality first (a pre-kit record); the dial edits it" : ''}`,
    }
    try {
      const home = getProjectDir(rec.workspaceId)
      mkdirSync(home, { recursive: true })
      appendSessionReceipt(home, rec.sessionId, {
        at: new Date().toISOString(),
        by,
        kind: 'kit-dial',
        summary: `kit dial: ${out.detail}`,
        details: { by, dials: describeEdit(edit), ...(materialized ? { materialized: true } : {}) },
      })
    } catch (err) {
      logForDebugging(`[kit] dial receipt failed for ${rec.sessionId}: ${err}`)
    }
  }, dir)
  return out
}
