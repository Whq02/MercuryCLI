#!/usr/bin/env bun
// ============================================================================
//  prove-skill-hooks-deapply — hooks a skill's frontmatter declared leave
//  the session when the skill does (release-hardening audit rank 62).
//
//  The gap: a skill's declared hooks registered into the session for good.
//  Turn the skill off in /skills or delete its SKILL.md and the hook kept
//  firing against every matching tool call for the rest of the session — a
//  blocking PreToolUse hook from a removed skill kept refusing tool calls, a
//  command hook kept spawning a shell per matching call. The registry for a
//  session id was emptied only by clearSessionHooks (subagent teardown, the
//  agent-hook runner, SessionEnd); removeSessionHook had no caller; there
//  was no unregister path at all.
//
//    L1 a skill-rooted group whose SKILL.md is gone is not served to the
//       hook runner (read-time liveness — honoured before any watcher
//       prunes the registry), while a rootless group and a live skill's
//       group still are
//    L2 the prune door removes every group of a skill that left the table
//       and never touches rootless groups or live skills
//    L3 the live-roots set is the fresh table's skill roots
//    L4 the skills-change rescan prunes against the fresh table
//       (source pin)
//
//  PROVE_SRC names another checkout's src (the A/B control: L1, L2 and L4
//  read red at the pre-fix tree).
// ============================================================================
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SRC = process.env.PROVE_SRC ?? join(import.meta.dir, '../../src')
const SCRATCH = mkdtempSync(join(tmpdir(), 'skill-hooks-'))
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'home')
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

const hooks = await import(join(SRC, 'utils/hooks/sessionHooks.ts'))
type Group = { matcher: string; skillRoot?: string; hooks: unknown[] }
type State = { sessionHooks: Map<string, { hooks: Record<string, Group[]> }> }
const state: State = { sessionHooks: new Map() }
const setAppState = (f: (prev: State) => State): void => {
  f(state)
}
const SID = 'skill-hooks-proof'

// Two skills on disk, one hook each, plus a rootless session hook.
const gone = join(SCRATCH, 'skills', 'gone')
const kept = join(SCRATCH, 'skills', 'kept')
for (const root of [gone, kept]) {
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'SKILL.md'), '---\nname: x\n---\nbody\n')
}
const hook = (name: string): unknown => ({ type: 'command', command: `echo ${name}` })
hooks.addSessionHook(setAppState as never, SID, 'PreToolUse', 'Bash', hook('gone-pre'), undefined, gone)
hooks.addSessionHook(setAppState as never, SID, 'PostToolUse', '*', hook('gone-post'), undefined, gone)
hooks.addSessionHook(setAppState as never, SID, 'PreToolUse', 'Bash', hook('kept-pre'), undefined, kept)
hooks.addSessionHook(setAppState as never, SID, 'PreToolUse', '*', hook('plain'))

const served = (): string[] => {
  const out: string[] = []
  for (const [event, groups] of hooks.getSessionHooks(state as never, SID) as Map<string, Array<{ matcher: string; skillRoot?: string; hooks: Array<{ command: string }> }>>) {
    for (const group of groups) for (const entry of group.hooks) out.push(`${event}:${entry.command.replace('echo ', '')}`)
  }
  return out.sort()
}

console.log('L1 read-time liveness')
check('precondition: all four hooks are served while both skills exist', served().join(',') === 'PostToolUse:gone-post,PreToolUse:gone-pre,PreToolUse:kept-pre,PreToolUse:plain', served().join(','))
rmSync(gone, { recursive: true, force: true })
check("the removed skill's hooks are no longer served, the rest are", served().join(',') === 'PreToolUse:kept-pre,PreToolUse:plain', served().join(','))
check('the registry still holds the dead groups (read-time gate, not yet pruned)', (state.sessionHooks.get(SID)?.hooks.PostToolUse ?? []).length === 1)

console.log('L2 the prune door')
{
  const prune = hooks.pruneSkillSessionHooks as ((s: unknown, sid: string, live: ReadonlySet<string>) => string[]) | undefined
  check('the prune door is exported', typeof prune === 'function')
  const removed = prune?.(setAppState, SID, new Set([kept])) ?? []
  check('the skill that left the table is named as removed', removed.length === 1 && removed[0] === gone, removed.join(','))
  const store = state.sessionHooks.get(SID)?.hooks ?? {}
  check('its PostToolUse event is gone from the registry entirely', store.PostToolUse === undefined)
  check("the live skill's group and the rootless group survive", (store.PreToolUse ?? []).length === 2 && served().join(',') === 'PreToolUse:kept-pre,PreToolUse:plain', served().join(','))
  const again = prune?.(setAppState, SID, new Set([kept])) ?? []
  check('a second prune removes nothing (idempotent)', again.length === 0)
}

console.log('L3 the live-roots set')
{
  const roots = hooks.liveSkillRootsOf as ((commands: Array<{ skillRoot?: string }>) => Set<string>) | undefined
  check('liveSkillRootsOf is exported', typeof roots === 'function')
  const live = roots?.([{ skillRoot: kept }, { skillRoot: undefined }, { skillRoot: kept }]) ?? new Set()
  check('it carries the fresh table\'s skill roots, deduplicated, no undefined', live.size === 1 && live.has(kept))
}

console.log('L4 the two de-apply roads prune (source pins)')
{
  const rescan = readFileSync(join(SRC, 'hooks/useSkillsChange.ts'), 'utf8')
  check('the skills-change rescan (a file removal) prunes against the fresh table', rescan.includes('pruneSkillSessionHooks(setAppState, getSessionId(), liveSkillRootsOf(commands))'))
  const runner = readFileSync(join(SRC, 'cli/print.ts'), 'utf8')
  check('the kit dial (a skill turned off) prunes against the post-dial table', runner.includes('pruneSkillSessionHooks(setAppState, getSessionId(), liveSkillRootsOf(activeCommands))'))
}

rmSync(SCRATCH, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-skill-hooks-deapply: ALL PASS' : `\nprove-skill-hooks-deapply: ${failures} FAIL`)
process.exit(failures === 0 ? 0 : 1)
