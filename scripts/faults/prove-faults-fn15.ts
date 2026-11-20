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
const { createFrameReader } = await import('../../src/services/lsp/sidecarFraming.js')

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

console.log('\nsidecarFraming.ts — createFrameReader does not mislabel onMessage errors as unparseable JSON')
{
  const protocolErrors: string[] = []
  const reader = createFrameReader(
    () => {
      throw new Error('handler bug')
    },
    err => {
      protocolErrors.push(err.message)
    },
  )
  const payload = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })
  const frame = Buffer.from(`Content-Length: ${Buffer.byteLength(payload)}\r\n\r\n${payload}`, 'utf8')
  let threw: unknown = null
  try {
    reader(frame)
  } catch (error) {
    threw = error
  }
  check(
    'createFrameReader lets onMessage throw instead of reporting unparseable JSON-RPC body',
    threw instanceof Error && threw.message === 'handler bug' && protocolErrors.length === 0,
    `threw=${String(threw)} protocolErrors=${JSON.stringify(protocolErrors)}`,
  )
  const badErrors: string[] = []
  const badReader = createFrameReader(() => {}, err => badErrors.push(err.message))
  const badBody = '{not-json'
  badReader(Buffer.from(`Content-Length: ${Buffer.byteLength(badBody)}\r\n\r\n${badBody}`, 'utf8'))
  check(
    'createFrameReader still reports unparseable JSON-RPC body on malformed JSON',
    badErrors.length === 1 && badErrors[0] === 'unparseable JSON-RPC body',
    `badErrors=${JSON.stringify(badErrors)}`,
  )
}

const { judgeGoal, JUDGE_UNREACHABLE } = await import('../../src/services/mission/goalJudge.js')
const { compileGoal } = await import('../../src/services/mission/goal.js')

console.log('\ngoalJudge.ts — judgeGoal fails closed when helper judge throws')
{
  const goal = compileGoal('the parser suite is green')
  const evidence = {
    closing: '1. the parser suite is green — all passing\nMERCURY_MISSION_MET',
    claimedMet: true,
    asksOperator: false,
    toolCalls: 1,
    toolNames: ['Bash'],
    verification: null,
    checks: 0,
  }
  const verdict = await judgeGoal(goal, evidence, {
    judge: async () => {
      throw new Error('judge exploded')
    },
  })
  check(
    'throwing helper judge yields not yet (JUDGE_UNREACHABLE) instead of falling through to met claim',
    verdict.kind === 'not yet' && verdict.reason === JUDGE_UNREACHABLE,
    JSON.stringify(verdict),
  )
}

rmSync(scratch, { recursive: true, force: true })
console.log(failures === 0 ? '\nGREEN' : `\nRED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
