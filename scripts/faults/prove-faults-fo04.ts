#!/usr/bin/env bun
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { check, decide, fill, finish, said, section } from '../permissions/floorsKit.ts'

const SECRET_RULE = { deny: [fill('Read(/<PROJECT>/secrets/**)')] }

section('a glob segment no reader translates does not reach the denied folder')
{
  const decision = await decide('Bash', { command: "sh -c 'cat secr[e-\\f]ts/k.txt'" }, 'implement', SECRET_RULE)
  check('cat secr[e-\\f]ts/k.txt, which bash expands into the denied secrets folder, is not allowed', decision.behavior !== 'allow', `make the Bash permission check refuse a glob segment it cannot translate when a deny rule could match it (src/tools/shell/bashPermissions.ts, bashToolHasPermission); got ${said(decision)}`)
}

section('a file URL whose path does not decode does not reach the denied folder')
{
  const decision = await decide('Bash', { command: `sh -c 'curl ${fill('file://<PROJECT>/secrets/k.txt%')}'` }, 'implement', SECRET_RULE)
  check('curl file://<project>/secrets/k.txt%, a path in the denied folder that decodeURI refuses, is not allowed', decision.behavior !== 'allow', `make the Bash permission check treat a file URL whose path does not decode as the denied path, not as allowed (src/tools/shell/bashPermissions.ts, bashToolHasPermission); got ${said(decision)}`)
}

section('pathValidation: a grep --include glob the reader cannot translate keeps the env-file ask')
{
  mkdirSync(fill('<PROJECT>/envtree'), { recursive: true })
  writeFileSync(join(fill('<PROJECT>/envtree'), '.env'), 'SECRET=CANARY-ENVTREE\n')
  const plain = await decide('Bash', { command: "grep -r --include='.env' SECRET envtree" }, 'implement')
  const odd = await decide('Bash', { command: "grep -r --include='.en[v-\\z]' SECRET envtree" }, 'implement')
  check('the plain include of .env asks first (the floor this row leans on)', plain.behavior !== 'allow', `the plain env-file include must ask before the glob row can hold; check the env-file path validation the Bash permission check applies (src/tools/shell/bashPermissions.ts); got ${said(plain)}`)
  check('an include of .en[v-\\z], which grep matches to .env, asks first too', odd.behavior !== 'allow', `an --include glob the reader cannot translate must keep the env-file ask: make the Bash path validation ask when it cannot translate the glob (src/tools/shell/bashPermissions.ts); got ${said(odd)}`)
}

section('hopIntoSession: a transcript that cannot be read is not resumed in the current folder')
if (process.platform !== 'win32' && process.getuid?.() !== 0) {
  const { chmodSync } = await import('node:fs')
  const transcript = fill('<PROJECT>/unreadable-transcript.jsonl')
  writeFileSync(transcript, `{"cwd":"${fill('<PROJECT>/elsewhere')}"}\n`)
  chmodSync(transcript, 0o000)
  const { focusResumedSession } = await import('../../src/daemon/switchboard/hopIntoSession.ts')
  const outcome = await Promise.race([
    focusResumedSession('6f1c2b4e-0d7a-4c3e-9b1a-2e5f8d9c0a11', transcript).then(o => ({ ok: o.ok, reason: o.ok ? '' : o.reason })),
    new Promise<{ ok: boolean; reason: string }>(done => setTimeout(() => done({ ok: true, reason: 'went on past the unreadable transcript' }), 5000)),
  ])
  chmodSync(transcript, 0o644)
  check('the resume answers not ok with the read error itself', !outcome.ok && /EACCES/.test(outcome.reason), `focusResumedSession must return ok false with the read error when the transcript cannot be read, not resume in the current folder (src/daemon/switchboard/hopIntoSession.ts); got ${outcome.reason}`)
}

section('harnessGround: a folder that cannot be entered is not recorded as the ground')
{
  const state = await import('../../src/boot/process-state/processState.ts')
  const { applyHarnessGround } = await import('../../src/daemon/switchboard/harnessGround.ts')
  const before = { original: state.getOriginalCwd(), root: state.getProjectRoot(), cwd: process.cwd() }
  const missing = fill('<PROJECT>/no-such-ground')
  const answered = await Promise.race([applyHarnessGround(missing), new Promise<string>(done => setTimeout(() => done('still grounding'), 10000))])
  const after = { original: state.getOriginalCwd(), root: state.getProjectRoot(), cwd: process.cwd() }
  check('the original cwd and project root stay where the process is', after.original === before.original && after.root === before.root && after.cwd === before.cwd, `applyHarnessGround must leave the original cwd, project root and process cwd unchanged when the folder cannot be entered (src/daemon/switchboard/harnessGround.ts); got ${JSON.stringify(after)}`)
  check('the answer is the folder the process stayed in', answered === before.cwd, `applyHarnessGround must return process.cwd() when chdir fails (src/daemon/switchboard/harnessGround.ts); got ${answered}`)
}

section('matching: one hook matcher that throws does not drop the other hooks of the event')
{
  const { mock } = await import('bun:test')
  const analysis = await import('../../src/permissions/rules/decision/commandAnalysis.ts')
  mock.module('../../src/permissions/rules/decision/commandAnalysis.ts', () => ({
    ...analysis,
    parseForSecurity: async () => {
      throw new Error('stand-in parser failure')
    },
  }))
  const { addSessionHooks } = await import('../../src/integrations/event-hooks/sessionHooks.ts')
  const { matchHooks } = await import('../../src/integrations/event-hooks/matching.ts')
  let state: Record<string, unknown> = { sessionHooks: new Map() }
  const setAppState = (f: (s: unknown) => unknown): void => {
    state = f(state) as Record<string, unknown>
  }
  const scope = { sessionId: 'faults-fo04' }
  addSessionHooks(setAppState as never, scope, {
    'tool.before': [
      { name: 'by-name', match: 'Bash', run: 'true' },
      { name: 'by-rule-closed', match: 'Bash(git *)', run: 'true', failClosed: true },
      { name: 'by-rule-open', match: 'Bash(npm *)', run: 'true' },
    ],
  } as never, { kind: 'agent', type: 'faults' } as never)
  const matched = await matchHooks('tool.before', { tool: 'Bash', input: { command: 'ls -la' } } as never, scope, { appState: state as never })
  const names = matched.map(hook => (hook.entry as { name?: string }).name).sort()
  check('the hook matched by name alone still runs when another matcher throws', names.includes('by-name'), `matchHooks must judge each hook matcher on its own, so one that throws drops only itself (src/integrations/event-hooks/matching.ts); matched ${names.join(', ') || 'no hooks'}`)
  check('the fail-closed hook whose matcher threw runs, the open one does not', names.includes('by-rule-closed') && !names.includes('by-rule-open'), `matchHooks must keep a hook with failClosed whose matcher threw and drop one without it (src/integrations/event-hooks/matching.ts); matched ${names.join(', ') || 'no hooks'}`)
}

finish('prove-faults-fo04')
