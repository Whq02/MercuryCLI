#!/usr/bin/env bun
import { HookRegistryOwner, type RegisteredHookMatcher } from '../../src/boot/process-state/runtime/hook-registry.ts'

const WHERE = 'HookRegistryOwner in src/boot/process-state/runtime/hook-registry.ts'
let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}
type Hooks = Parameters<HookRegistryOwner['registerHookCallbacks']>[0]
type Event = keyof Hooks
const matcher = (name: string): RegisteredHookMatcher => ({ matcher: name, hooks: [] }) as never
const names = (owner: HookRegistryOwner, event: Event): string => (owner.registeredHooks?.[event] ?? []).map(entry => (entry as { matcher?: string }).matcher).join(',')
const [FIRST, SECOND, THIRD] = ['tool.before', 'tool.after', 'session.start'] as Event[]

console.log('§1 a new registry')
{
  const owner = new HookRegistryOwner()
  check('holds no record at all, not an empty one', owner.registeredHooks === null, JSON.stringify(owner.registeredHooks))
}

console.log('§2 registering')
{
  const owner = new HookRegistryOwner()
  const a = matcher('a')
  const b = matcher('b')
  owner.registerHookCallbacks({ [FIRST!]: [a, b] } as Hooks)
  check('the matchers of an event are held under that event, in the order given', names(owner, FIRST!) === 'a,b' && owner.registeredHooks?.[FIRST!]?.[0] === a && owner.registeredHooks?.[FIRST!]?.[1] === b, `${names(owner, FIRST!)}; see ${WHERE}`)
  check('an event nobody registered has no entry', owner.registeredHooks !== null && !(SECOND! in owner.registeredHooks), JSON.stringify(Object.keys(owner.registeredHooks ?? {})))
  owner.registerHookCallbacks({ [FIRST!]: [matcher('c')], [SECOND!]: [matcher('d')] } as Hooks)
  check('a later registration adds after what is there and never replaces it', names(owner, FIRST!) === 'a,b,c' && names(owner, SECOND!) === 'd', `${names(owner, FIRST!)} | ${names(owner, SECOND!)}`)
  owner.registerHookCallbacks({ [FIRST!]: [a] } as Hooks)
  check('the same matcher registered twice is held twice', names(owner, FIRST!) === 'a,b,c,a', names(owner, FIRST!))
  check('the events stand in the order they were first registered', Object.keys(owner.registeredHooks ?? {}).join(',') === `${String(FIRST)},${String(SECOND)}`, Object.keys(owner.registeredHooks ?? {}).join(','))
  const given = [matcher('e')]
  owner.registerHookCallbacks({ [THIRD!]: given } as Hooks)
  given.push(matcher('late'))
  check('the list handed in is copied: adding to it afterwards adds nothing to the registry', names(owner, THIRD!) === 'e', names(owner, THIRD!))
  owner.registerHookCallbacks({ [THIRD!]: [] } as Hooks)
  owner.registerHookCallbacks({} as Hooks)
  check('an empty list and an empty record change nothing', names(owner, THIRD!) === 'e' && Object.keys(owner.registeredHooks ?? {}).length === 3)
}

console.log('§3 clearing')
{
  const owner = new HookRegistryOwner()
  owner.clearRegisteredExtensionHooks()
  check('clearing a registry that holds nothing leaves it with no record', owner.registeredHooks === null)
  owner.registerHookCallbacks({ [FIRST!]: [matcher('a')] } as Hooks)
  owner.clearRegisteredExtensionHooks()
  check('clearing forgets every event: there is no record again', owner.registeredHooks === null, JSON.stringify(owner.registeredHooks))
  owner.registerHookCallbacks({ [SECOND!]: [matcher('b')] } as Hooks)
  check('after a clear, registering starts from nothing', Object.keys(owner.registeredHooks ?? {}).join(',') === String(SECOND) && names(owner, SECOND!) === 'b', JSON.stringify(Object.keys(owner.registeredHooks ?? {})))
  const other = new HookRegistryOwner()
  check('two registries share nothing', other.registeredHooks === null)
}

if (failures > 0) {
  console.error(`\nprove-hook-registry-behaviour: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-hook-registry-behaviour: all green')
