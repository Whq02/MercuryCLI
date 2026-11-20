#!/usr/bin/env bun
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { check, decide, fill, finish, said, section } from '../permissions/floorsKit.ts'

const SECRET_RULE = { deny: [fill('Read(/<PROJECT>/secrets/**)')] }

section('a glob segment no reader translates does not reach the denied folder')
{
  const decision = await decide('Bash', { command: "sh -c 'cat secr[e-\\f]ts/k.txt'" }, 'implement', SECRET_RULE)
  check('cat secr[e-\\f]ts/k.txt, which bash expands into the denied secrets folder, is not allowed', decision.behavior !== 'allow', said(decision))
}

section('a file URL whose path does not decode does not reach the denied folder')
{
  const decision = await decide('Bash', { command: `sh -c 'curl ${fill('file://<PROJECT>/secrets/k.txt%')}'` }, 'implement', SECRET_RULE)
  check('curl file://<project>/secrets/k.txt%, a path in the denied folder that decodeURI refuses, is not allowed', decision.behavior !== 'allow', said(decision))
}

section('pathValidation: a grep --include glob the reader cannot translate keeps the env-file ask')
{
  mkdirSync(fill('<PROJECT>/envtree'), { recursive: true })
  writeFileSync(join(fill('<PROJECT>/envtree'), '.env'), 'SECRET=CANARY-ENVTREE\n')
  const plain = await decide('Bash', { command: "grep -r --include='.env' SECRET envtree" }, 'implement')
  const odd = await decide('Bash', { command: "grep -r --include='.en[v-\\z]' SECRET envtree" }, 'implement')
  check('the plain include of .env asks first (the floor this row leans on)', plain.behavior !== 'allow', said(plain))
  check('an include of .en[v-\\z], which grep matches to .env, asks first too', odd.behavior !== 'allow', said(odd))
}

section('matching: one hook matcher that throws does not drop the other hooks of the event')
{
  const { mock } = await import('bun:test')
  const analysis = await import('../../src/utils/permissions/decision/commandAnalysis.ts')
  mock.module('../../src/utils/permissions/decision/commandAnalysis.ts', () => ({
    ...analysis,
    parseForSecurity: async () => {
      throw new Error('stand-in parser failure')
    },
  }))
  const { addSessionHooks } = await import('../../src/utils/hooks/sessionHooks.ts')
  const { matchHooks } = await import('../../src/utils/hooks/matching.ts')
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
  check('the hook matched by name alone still runs when another matcher throws', names.includes('by-name'), names.join(', ') || 'no hooks')
  check('the fail-closed hook whose matcher threw runs, the open one does not', names.includes('by-rule-closed') && !names.includes('by-rule-open'), names.join(', ') || 'no hooks')
}

finish('prove-faults-fo04')
