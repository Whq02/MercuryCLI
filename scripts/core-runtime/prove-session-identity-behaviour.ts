#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionIdentityOwner } from '../../src/boot/process-state/runtime/session-identity.ts'
import { removeScratch } from '../lib/removeScratch.ts'

const WHERE = 'SessionIdentityOwner in src/boot/process-state/runtime/session-identity.ts'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const DECOMPOSED = 'cafe\u0301'
const COMPOSED = 'caf\u00e9'
type Id = SessionIdentityOwner['sessionId']
const id = (text: string): Id => text as Id

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}
const section = (title: string): void => console.log(`\n${'─'.repeat(76)}\n${title}`)

const before = process.cwd()
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'session-identity-')))
try {
  section('§1 a new owner starts in the folder the process stands in')
  {
    const plain = join(scratch, 'plain')
    mkdirSync(plain)
    process.chdir(plain)
    const owner = new SessionIdentityOwner()
    const here = realpathSync(process.cwd()).normalize('NFC')
    check('the start folder, the project root and the current folder are all the resolved process folder', owner.originalCwd === here && owner.projectRoot === here && owner.cwd === here, `${JSON.stringify([owner.originalCwd, owner.projectRoot, owner.cwd])} against ${here}; the constructor of ${WHERE} must read the process folder once and resolve it`)
    check('it has a session id shaped as a random UUID', UUID.test(owner.sessionId), owner.sessionId)
    check('it has no session project folder and no plan word yet', owner.sessionProjectDir === null && owner.planSlugCache instanceof Map && owner.planSlugCache.size === 0)
    check('a second owner has another session id', new SessionIdentityOwner().sessionId !== owner.sessionId, `two owners of ${WHERE} must not share an id`)
  }
  {
    const target = join(scratch, 'target')
    const link = join(scratch, 'link')
    mkdirSync(target)
    symlinkSync(target, link)
    process.chdir(link)
    const owner = new SessionIdentityOwner()
    check('started through a linked folder, it holds the folder the link leads to', owner.cwd === realpathSync(target) && owner.originalCwd === owner.cwd && owner.projectRoot === owner.cwd, `${owner.cwd} against ${realpathSync(target)}`)
  }
  {
    const accented = join(scratch, DECOMPOSED)
    mkdirSync(accented)
    process.chdir(accented)
    const owner = new SessionIdentityOwner()
    check('a folder name with a decomposed accent is held in composed form', owner.cwd === realpathSync(process.cwd()).normalize('NFC') && owner.cwd.endsWith(COMPOSED) && owner.originalCwd === owner.cwd && owner.projectRoot === owner.cwd, `${JSON.stringify(owner.cwd)}; ${WHERE} must hold every folder in NFC`)
  }
  process.chdir(scratch)

  section('§2 the three folder setters')
  {
    const owner = new SessionIdentityOwner()
    const start = owner.cwd
    const told: string[] = []
    owner.onCwdChange(cwd => told.push(cwd))
    owner.setOriginalCwd(`/nowhere/${DECOMPOSED}/a`)
    check('setOriginalCwd stores the text in composed form and moves nothing else', owner.originalCwd === `/nowhere/${COMPOSED}/a` && owner.projectRoot === start && owner.cwd === start, JSON.stringify([owner.originalCwd, owner.projectRoot, owner.cwd]))
    owner.setProjectRoot(`/nowhere/${DECOMPOSED}/b`)
    check('setProjectRoot stores the text in composed form and moves nothing else', owner.projectRoot === `/nowhere/${COMPOSED}/b` && owner.originalCwd === `/nowhere/${COMPOSED}/a` && owner.cwd === start, JSON.stringify([owner.originalCwd, owner.projectRoot, owner.cwd]))
    check('neither of the two tells a folder listener', told.length === 0, JSON.stringify(told))
    owner.setCwdState(`/nowhere/${DECOMPOSED}/c`)
    check('setCwdState stores the text in composed form, as given, without resolving it', owner.cwd === `/nowhere/${COMPOSED}/c` && owner.originalCwd === `/nowhere/${COMPOSED}/a` && owner.projectRoot === `/nowhere/${COMPOSED}/b`, JSON.stringify(owner.cwd))
    check('and tells the folder listener once, with the stored text', told.length === 1 && told[0] === `/nowhere/${COMPOSED}/c`, JSON.stringify(told))
  }

  section('§3 folder listeners')
  {
    const owner = new SessionIdentityOwner()
    const order: string[] = []
    const seenAtTelling: string[] = []
    const offFirst = owner.onCwdChange(cwd => order.push(`first:${cwd}`))
    owner.onCwdChange(cwd => {
      order.push(`second:${cwd}`)
      seenAtTelling.push(owner.cwd)
    })
    owner.onCwdChange(cwd => order.push(`third:${cwd}`))
    owner.setCwdState('/one')
    check('every listener is told, in the order they were added', order.join(' ') === 'first:/one second:/one third:/one', order.join(' '))
    check('the owner already holds the new folder when a listener is told', seenAtTelling[0] === '/one', JSON.stringify(seenAtTelling))
    check('adding a listener hands back a function', typeof offFirst === 'function')
    offFirst()
    owner.setCwdState('/two')
    check('a removed listener is told no more, the others still in order', order.slice(3).join(' ') === 'second:/two third:/two', order.slice(3).join(' '))
    offFirst()
    owner.setCwdState('/three')
    check('removing it a second time changes nothing', order.slice(5).join(' ') === 'second:/three third:/three', order.slice(5).join(' '))
    const other = new SessionIdentityOwner()
    other.setCwdState('/elsewhere')
    check('a listener of one owner is not told about another owner', order.length === 7, String(order.length))
  }
  {
    const owner = new SessionIdentityOwner()
    const later: string[] = []
    owner.onCwdChange(() => {
      throw new Error('listener failed')
    })
    owner.onCwdChange(cwd => later.push(cwd))
    let thrown = ''
    try {
      owner.setCwdState('/after')
    } catch (error) {
      thrown = error instanceof Error ? error.message : String(error)
    }
    check('a listener that throws: its error reaches the caller of setCwdState', thrown === 'listener failed', JSON.stringify(thrown))
    check('the folder is changed all the same', owner.cwd === '/after', owner.cwd)
    check('and the listeners after it are not told', later.length === 0, JSON.stringify(later))
  }

  section('§4 switching to another session')
  {
    const owner = new SessionIdentityOwner()
    const born = owner.sessionId
    const told: string[] = []
    const held: string[] = []
    owner.onSessionSwitch(next => {
      told.push(next)
      held.push(owner.sessionId)
    })
    owner.planSlugCache.set(born, 'plan-of-born')
    owner.planSlugCache.set(id('someone-else'), 'plan-of-someone-else')
    owner.switchSession(id('11111111-1111-4111-8111-111111111111'), '/projects/one')
    check('the owner holds the given id and the given project folder', owner.sessionId === '11111111-1111-4111-8111-111111111111' && owner.sessionProjectDir === '/projects/one', JSON.stringify([owner.sessionId, owner.sessionProjectDir]))
    check('the session listener is told once, with the new id, when the owner already holds it', told.join(',') === '11111111-1111-4111-8111-111111111111' && held.join(',') === told.join(','), JSON.stringify([told, held]))
    check('the plan word kept under the id it left is gone, another id keeps its own', !owner.planSlugCache.has(born) && owner.planSlugCache.get(id('someone-else')) === 'plan-of-someone-else', JSON.stringify([...owner.planSlugCache]))
    owner.planSlugCache.set(owner.sessionId, 'plan-of-one')
    owner.switchSession(id('22222222-2222-4222-8222-222222222222'))
    check('a switch with no project folder given leaves none', owner.sessionId === '22222222-2222-4222-8222-222222222222' && owner.sessionProjectDir === null, JSON.stringify(owner.sessionProjectDir))
    check('and again drops the plan word of the id it left', !owner.planSlugCache.has(id('11111111-1111-4111-8111-111111111111')) && owner.planSlugCache.size === 1, JSON.stringify([...owner.planSlugCache]))
    check('the folders do not move on a switch', owner.cwd === scratch && owner.originalCwd === scratch && owner.projectRoot === scratch, JSON.stringify([owner.cwd, owner.originalCwd, owner.projectRoot]))
  }
  {
    const owner = new SessionIdentityOwner()
    const order: string[] = []
    const off = owner.onSessionSwitch(next => order.push(`first:${next}`))
    owner.onSessionSwitch(next => order.push(`second:${next}`))
    owner.switchSession(id('a'))
    off()
    owner.switchSession(id('b'))
    check('session listeners are told in the order added, and a removed one no more', order.join(' ') === 'first:a second:a second:b', order.join(' '))
    const folders: string[] = []
    owner.onCwdChange(cwd => folders.push(cwd))
    owner.switchSession(id('c'))
    check('a switch tells no folder listener', folders.length === 0, JSON.stringify(folders))
  }

  section('§5 a fresh id for the same owner')
  {
    const owner = new SessionIdentityOwner()
    const told: string[] = []
    owner.onSessionSwitch(next => told.push(next))
    owner.switchSession(id('33333333-3333-4333-8333-333333333333'), '/projects/three')
    owner.planSlugCache.set(owner.sessionId, 'plan-of-three')
    owner.planSlugCache.set(id('someone-else'), 'kept')
    const fresh = owner.regenerateSessionId()
    check('regenerateSessionId answers a new random id and the owner holds it', UUID.test(fresh) && fresh !== '33333333-3333-4333-8333-333333333333' && owner.sessionId === fresh, fresh)
    check('the project folder of the session is cleared', owner.sessionProjectDir === null, JSON.stringify(owner.sessionProjectDir))
    check('the plan word of the id it left is gone, another id keeps its own', !owner.planSlugCache.has(id('33333333-3333-4333-8333-333333333333')) && owner.planSlugCache.get(id('someone-else')) === 'kept', JSON.stringify([...owner.planSlugCache]))
    check('no session listener is told about a fresh id', told.length === 1, `${JSON.stringify(told)}; only switchSession of ${WHERE} tells the session listeners`)
    check('a second fresh id differs from the first', owner.regenerateSessionId() !== fresh)
  }
} finally {
  process.chdir(before)
  removeScratch(scratch)
}

if (failures > 0) {
  console.error(`\nprove-session-identity-behaviour: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-session-identity-behaviour: all green')
