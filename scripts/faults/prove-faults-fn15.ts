#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'mercury-faults-fn15-')))
const home = join(scratch, 'home')
mkdirSync(home, { recursive: true })
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.NODE_ENV = 'test'
delete process.env.MERCURY_HOME
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

const { workspaceSymbolRequest } = await import('../../src/services/lsp/tsSidecar/sidecar/requests/navigation.js')

console.log('\nnavigation.ts — workspaceSymbolRequest propagates project getNavigateToItems failures')
{
  const brokenProject = {
    service: {
      getNavigateToItems: () => {
        throw new Error('ts language service exploded')
      },
    },
  }
  const fakeState = {
    workspaceProjects: () => [brokenProject],
    allProjects: () => [brokenProject],
    normalize: (p: string) => p,
    textOf: () => '',
  }
  let threw: unknown = null
  try {
    workspaceSymbolRequest({ query: 'foo' }, () => fakeState as never)
  } catch (error) {
    threw = error
  }
  check(
    'workspaceSymbolRequest throws instead of returning an empty symbol list',
    threw instanceof Error && threw.message === 'ts language service exploded',
    `threw=${String(threw)}`,
  )
}

rmSync(scratch, { recursive: true, force: true })
console.log(failures === 0 ? '\nGREEN' : `\nRED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
