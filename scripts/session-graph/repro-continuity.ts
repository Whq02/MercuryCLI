#!/usr/bin/env bun
import { checker } from '../engine-durability/harness.ts'

const t = checker()


t.section('CS-23 — cross-surface resolution (live once the projection exists)')
let mod: Record<string, unknown> | null = null
try {
  mod = (await import('../../src/crew/crewmates/projection.ts')) as Record<string, unknown>
} catch {
  mod = null
}
const probe = mod?.__continuityLawsForProof as
  | undefined
  | (() => Promise<{
      sameAgentIdEverySurface: boolean
      deliberateSameThreadSameCursor: boolean
      restartPreservesIdentityAndCursor: boolean
    }>)
const r = typeof probe === 'function' ? await probe() : null
t.check('the continuity law probe exists (__continuityLawsForProof)', r !== null)
t.check('every surface resolves the same canonical AgentId', r?.sameAgentIdEverySurface === true)
t.check('deliberately opening one thread from two surfaces agrees on id + cursor', r?.deliberateSameThreadSameCursor === true)
t.check('restart preserves identity, title, unread cursor', r?.restartPreservesIdentityAndCursor === true)

t.finish('repro-continuity')
