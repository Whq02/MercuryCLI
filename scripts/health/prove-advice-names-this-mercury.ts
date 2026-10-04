#!/usr/bin/env bun
import '../lib/hermetic.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}

const { ownCommandWord, thisMercuryCommand } = await import('../../src/services/privateChannel/installPath.ts')

const node = '/opt/homebrew/Cellar/node@24/24.20.0/bin/node'
const bundle = '/Users/op/pre27-air/pre27/dist/mercury.mjs'
const installed = { state: 'stable' as const, resolved: '/Users/op/.local/bin/mercury' }
const another = { state: 'other' as const, resolved: '/Users/op/.local/bin/mercury', npmWrapper: false }
const absent = { state: 'absent' as const }

console.log('§1 the command word that names THIS Mercury')
check('a managed install whose stable command is on PATH is addressed by its word', ownCommandWord({ provenanceKind: 'managed', found: installed, node, bundle }) === 'mercury')
check("a source build never borrows the word when the PATH's mercury is another install", ownCommandWord({ provenanceKind: 'development', found: another, node, bundle }) === `${node} ${bundle}`, ownCommandWord({ provenanceKind: 'development', found: another, node, bundle }))
check('a source build with no mercury on PATH is addressed by its own invocation', ownCommandWord({ provenanceKind: 'development', found: absent, node, bundle }) === `${node} ${bundle}`)
check("a managed install shadowed by another launcher on PATH is addressed by its own invocation", ownCommandWord({ provenanceKind: 'managed', found: another, node, bundle }) === `${node} ${bundle}`)
check('a Homebrew or npm install on PATH keeps its word', ownCommandWord({ provenanceKind: 'homebrew', found: another, node, bundle }) === 'mercury' && ownCommandWord({ provenanceKind: 'npm', found: another, node, bundle }) === 'mercury')
check('a path with a space is quoted', ownCommandWord({ provenanceKind: 'development', found: absent, node: 'C:\\Program Files\\nodejs\\node.exe', bundle: 'C:\\pre27 field\\dist\\mercury.mjs' }) === '"C:\\\\Program Files\\\\nodejs\\\\node.exe" "C:\\\\pre27 field\\\\dist\\\\mercury.mjs"', ownCommandWord({ provenanceKind: 'development', found: absent, node: 'C:\\Program Files\\nodejs\\node.exe', bundle: 'C:\\pre27 field\\dist\\mercury.mjs' }))
check('with no bundle to name the word stands', ownCommandWord({ provenanceKind: 'development', found: absent, node, bundle: undefined }) === 'mercury')
const live = thisMercuryCommand()
check('the live resolver answers a non-empty command and memoises it', live.length > 0 && thisMercuryCommand() === live, live)

console.log(`\n${failures === 0 ? 'ALL LAWS HOLD' : `${failures} FAILURE(S)`} — prove-advice-names-this-mercury`)
process.exit(failures === 0 ? 0 : 1)
