#!/usr/bin/env bun
// prove-topic-memory-verbs — the MCP surface, probed over a REAL client/server pair
// (InMemoryTransport), not by grepping registration code:
//
//   §1 MERCURY_MNEME off ⇒ the mneme_* verbs are ABSENT from tools/list while the
//      control verbs (lease_*) remain — byte-identical catalog.
//   §2 MERCURY_MNEME=1 ⇒ all five verbs listed.
//   §3 a real mneme_observe round-trip lands a buffer row in the ISOLATED
//      memory dir; mneme_catalog/read answer over it after consolidation.
//   §4 the live re-check: flipping the flag OFF mid-session makes a listed
//      verb REFUSE (authority-toggles — registration is boot-time, authority
//      is live).
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
// Config-home isolation BEFORE any import resolves getAutoMemPath. There is
// no SDK memory-path override;
// the config home is the whole-process
// isolation seam, so the library lands at <memDir>/projects/<key>/memory/
// library — resolved below through the real mnemeLibraryDir, never rebuilt
// by hand.
const memDir = mkdtempSync(join(tmpdir(), 'mneme-verbs-mem-'))
process.env.MERCURY_CONFIG_DIR = memDir
process.env.MERCURY_COORDINATION_MCP = '1'

const { createCoordinationServer } = await import('../../src/services/mcp/coordinationServer.ts')
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js')
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

async function connectedClient(): Promise<{ client: InstanceType<typeof Client>; close: () => Promise<void> }> {
  const server = await createCoordinationServer()
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'mneme-proof', version: '0' })
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  return { client, close: async () => { await client.close(); await server.close() } }
}

const MNEME_VERBS = ['mneme_observe', 'mneme_catalog', 'mneme_grep', 'mneme_grep_doc', 'mneme_read']

section('§1 flag OFF ⇒ verbs absent (real tools/list)')
{
  delete process.env.MERCURY_MNEME
  const { client, close } = await connectedClient()
  const names = (await client.listTools()).tools.map(t => t.name)
  check('no mneme_* in the catalog', MNEME_VERBS.every(v => !names.includes(v)), names.filter(n => n.startsWith('mneme')).join(','))
  check('control verbs still present', names.includes('lease_claim') && names.includes('render_tui'))
  await close()
}

section('§2 flag ON ⇒ all five verbs listed')
{
  process.env.MERCURY_MNEME = '1'
  const { client, close } = await connectedClient()
  const names = (await client.listTools()).tools.map(t => t.name)
  check('all five present', MNEME_VERBS.every(v => names.includes(v)), names.filter(n => n.startsWith('mneme')).join(','))
  await close()
}

section('§3 real observe → consolidate → catalog/read round-trip')
{
  process.env.MERCURY_MNEME = '1'
  const { client, close } = await connectedClient()
  const obs = await client.callTool({ name: 'mneme_observe', arguments: { text: 'the verbs round-trip through a real client', source: 'proof', topicHint: 'mcp surface' } })
  const obsPayload = JSON.parse((obs.content as Array<{ type: string; text: string }>)[0]!.text) as { ok?: boolean }
  check('observe acknowledged', !obs.isError && obsPayload.ok === true, JSON.stringify(obsPayload).slice(0, 120))
  const { mnemeLibraryDir } = await import('../../src/memdir/mnemeGates.ts')
  const libDir = mnemeLibraryDir()
  check('buffer row landed in the ISOLATED dir', libDir.startsWith(memDir) && existsSync(join(libDir, 'current.jsonl')), libDir)
  const { maybeConsolidate } = await import('../../src/memdir/mnemeConsolidate.ts')
  check('force consolidation', maybeConsolidate({ force: true, dir: libDir }).consolidated)
  const cat = await client.callTool({ name: 'mneme_catalog', arguments: {} })
  check('catalog lists the doc', JSON.stringify(cat.content).includes('topic-mcp-surface'))
  const read = await client.callTool({ name: 'mneme_read', arguments: { slug: 'mcp-surface' } })
  check('read returns the signed entry', JSON.stringify(read.content).includes('seq=1'))
  await close()
}

section('§4 live authority: flag flipped off mid-session ⇒ listed verb refuses')
{
  process.env.MERCURY_MNEME = '1'
  const { client, close } = await connectedClient()
  delete process.env.MERCURY_MNEME
  const r = await client.callTool({ name: 'mneme_catalog', arguments: {} })
  check('refuses after the flip', r.isError === true && JSON.stringify(r.content).includes('disabled'), JSON.stringify(r.content).slice(0, 120))
  process.env.MERCURY_MNEME = '1'
  const r2 = await client.callTool({ name: 'mneme_catalog', arguments: {} })
  check('answers again once re-enabled (live read)', !r2.isError)
  await close()
}

console.log('\n' + '═'.repeat(76))
if (failures) {
  console.log(`❌ ${failures} MNEME VERBS PROOF FAILURE(S)`)
  process.exit(1)
}
console.log('✅ ALL MNEME VERBS PROOFS PASS')
