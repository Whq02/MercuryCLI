#!/usr/bin/env bun
import { proofHome } from '../lib/hermetic.ts'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Client, type CallToolResult } from '@modelcontextprotocol/client'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const root = join(proofHome, 'work')
mkdirSync(join(root, 'assets', 'icons'), { recursive: true })
writeFileSync(join(root, 'notes.txt'), 'notes\n')
const { switchSession, setOriginalCwd } = await import('../../src/bootstrap/state.ts')
setOriginalCwd(root)
switchSession('00000000-0000-4000-8000-000000000052' as never, root)
const { projectLeaseHolder, takeProjectLeases, releaseProjectLeases, describeProjectLeases, engineLeaseRefusal } = await import('../../src/services/vulcan/engine/leases.ts')
const { createMercuryServer, withMercuryLeaseHolder } = await import('../../src/services/mcp/mercuryServer.ts')
const { createLinkedTransportPair } = await import('../../src/services/mcp/InProcessTransport.ts')

let checks = 0
let failures = 0
function check(label: string, ok: boolean, detail: unknown = ''): void {
  checks++
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${!ok ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)?.slice(0, 600)}` : ''}`)
}
const owner = projectLeaseHolder('tree-owner')
const other = projectLeaseHolder('other')
const names = (holder: typeof owner): string => `leased by session ${holder.sessionId}, agent ${holder.agentId} (pid ${holder.pid})`
const refusal = async (paths: string[], holder = other): Promise<string> => {
  try {
    const result = await takeProjectLeases(root, paths, holder)
    return result.ok ? `ok: ${result.leases.map(lease => lease.path).join(',')}` : result.message
  } catch (error) {
    return `error: ${(error as Error).message}`
  }
}
const server = await createMercuryServer()
const client = new Client({ name: 'lease-directory-proof', version: '0' })
const [a, b] = createLinkedTransportPair()
type LeaseCallResult = CallToolResult & { structuredContent?: Record<string, unknown> }
const call = (name: string, args: Record<string, unknown>, agentId?: string): Promise<LeaseCallResult> => withMercuryLeaseHolder(agentId, () => client.callTool({ name, arguments: args })) as Promise<LeaseCallResult>
const textOf = (result: LeaseCallResult): string => (result.content as Array<{ text?: string }>).map(block => block.text ?? '').join('')

try {
  await Promise.all([server.connect(a), client.connect(b)])

  const tree = await takeProjectLeases(root, ['art/'], owner)
  check('a trailing slash takes one directory lease for a tree that does not exist yet', tree.ok && tree.held === 1 && tree.under === 'art/' && tree.leases[0]?.path === 'art/', tree)
  check('a file under the directory is refused with the directory named', await refusal(['art/x.png']) === `art/x.png is under art/, ${names(owner)}`, await refusal(['art/x.png']))
  check('a deeper file is refused the same way', await refusal(['art/sub/deep/y.png']) === `art/sub/deep/y.png is under art/, ${names(owner)}`)
  check('the directory itself is refused in today\'s words', await refusal(['art/']) === `art/ is ${names(owner)}`)
  check('a directory under it is refused with the covering directory named', await refusal(['art/sub/']) === `art/sub/ is under art/, ${names(owner)}`)
  check('a sibling whose name merely starts the same is free', (await refusal(['artwork/x.png'])).startsWith('ok:'))
  check('the owner adds files under its own directory freely', (await refusal(['art/sub/y.png'], owner)) === 'ok: art/,art/sub/y.png')

  const held = await takeProjectLeases(root, ['other/a.png'], other)
  check('another holder takes a file elsewhere', held.ok)
  check('a directory cannot be taken over someone\'s file under it', await refusal(['other/'], owner) === `other/a.png is ${names(other)}`)
  check('nor over a file deeper down', await refusal(['other/'], owner) === `other/a.png is ${names(other)}` && (await refusal(['oth/'], owner)).startsWith('ok:'))

  check('a future file taken by one holder refuses the same path as a directory to another', (await refusal(['future-file'], owner)) === 'ok: art/,art/sub/y.png,future-file,oth/' && await refusal(['future-file/']) === `future-file is ${names(owner)}`)
  check('a future directory taken by one holder refuses the same path as a file to another', (await refusal(['future-dir/'], owner)).startsWith('ok:') && await refusal(['future-dir']) === `future-dir/ is ${names(owner)}`)
  check('the same two kinds collide below the top level, in both directions', (await refusal(['deep/file'], owner)).startsWith('ok:') && await refusal(['deep/file/']) === `deep/file is ${names(owner)}` && (await refusal(['deep/dir/'], owner)).startsWith('ok:') && await refusal(['deep/dir']) === `deep/dir/ is ${names(owner)}`)
  check('the engine run refusal reads the opposite kind too', await engineLeaseRefusal(root, { commit: 'HEAD', baseBlobs: new Map([['future-dir', 'a']]), overlay: new Map([['future-dir', 'b']]) }, other) === `future-dir/ is ${names(owner)}`)
  await releaseProjectLeases(root, owner, ['future-file', 'future-dir/', 'deep/file', 'deep/dir/'])

  check('an existing directory named without a slash is a directory lease', (await refusal(['assets/icons'], owner)) === 'ok: art/,art/sub/y.png,assets/icons/,oth/')
  check('a trailing slash on a file is refused by name', await refusal(['notes.txt/'], owner) === 'error: lease path names a file, not a directory: notes.txt/')
  check('the project directory that holds the lease store cannot be covered', await refusal(['.mercury/'], owner) === 'error: .mercury/ holds the lease store and cannot be leased')
  check('globs stay refused', await refusal(['art/*.png'], owner) === 'error: lease paths name project files or directories, not globs')

  const facts = { commit: 'HEAD', baseBlobs: new Map([['art/z.png', 'a']]), overlay: new Map([['art/z.png', 'b']]) }
  check('the engine refuses another holder\'s run over a file under the directory, naming it', await engineLeaseRefusal(root, facts, other) === `art/z.png is under art/, ${names(owner)}`)
  check('the engine lets the owner run over its own tree', await engineLeaseRefusal(root, facts, owner) === null)

  const listing = await describeProjectLeases(root)
  const ownerRow = listing.holders.find(row => row.holder.agentId === owner.agentId)
  check('the listing counts the directory lease as one row', listing.total === 6 && ownerRow?.count === 4 && listing.leases?.some(lease => lease.path === 'art/') === true, listing)

  const released = await releaseProjectLeases(root, owner, ['art/'])
  check('releasing the directory frees the tree for others while the owner\'s file under it stays', released.released === 1 && (await refusal(['art/x.png'])).startsWith('ok:') && await refusal(['art/sub/y.png']) === `art/sub/y.png is ${names(owner)}`, released)

  const served = await call('lease_take', { paths: ['pack/'] }, 'seat-a')
  check('lease_take through the server takes a directory and reports it as the holder\'s directory', !served.isError && textOf(served).includes('"under": "pack/"') && textOf(served).includes('"held": 1'), textOf(served).slice(0, 300))
  const covered = await call('lease_take', { paths: ['pack/frame-1.png', 'pack/frame-2.png'] }, 'seat-b')
  check('a seat asking for files under it reads the directory in the refusal', !covered.isError && textOf(covered).includes('"ok": false') && textOf(covered).includes('pack/frame-1.png is under pack/, leased by session'), textOf(covered).slice(0, 300))
  const description = (await client.listTools()).tools.find(tool => tool.name === 'lease_take')?.description ?? ''
  check('the tool says a directory with a trailing slash is one lease over everything under it', description.includes('directory with a trailing slash') && description.includes('covering everything under it'), description)
} finally {
  await releaseProjectLeases(root, owner)
  await releaseProjectLeases(root, other)
  await releaseProjectLeases(root, projectLeaseHolder(), undefined, { all: true })
  await server.close()
  await client.close()
  rmSync(proofHome, { recursive: true, force: true })
}
console.log(`${checks} checks, ${failures} failures`)
process.exit(failures ? 1 : 0)
