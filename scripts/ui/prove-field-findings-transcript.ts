#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')

let failures = 0
const check = (name: string, ok: boolean, detail?: string): void => {
  if (ok) {
    console.log(`  ok  ${name}`)
  } else {
    failures++
    console.error(`  RED ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

console.log('§1 ctr-1 — the key index follows the in-place append')
{
  const hook = read('src/hooks/useVirtualScroll.ts')
  check('the index remembers how many keys it has indexed', hook.includes('map: Map<string, number>; indexed: number }>({') && hook.includes('ki.indexed = keys.length'))
  check('the same identity, grown, indexes only the new tail (O(delta))', hook.includes('} else if (ki.indexed < keys.length) {') && hook.includes('for (let i = ki.indexed; i < keys.length; i++) ki.map.set(keys[i]!, i)'))
  check('POISON: the identity-only rebuild is gone', !/if \(ki\.keys !== keys\) \{\s*\n\s*ki\.map\.clear\(\)\s*\n\s*for \(let i = 0; i < keys\.length; i\+\+\) ki\.map\.set\(keys\[i\]!, i\)\s*\n\s*ki\.keys = keys\s*\n\s*\}\s*\n\s*return ki\.map\.get\(key\)/.test(hook))
  const list = read('src/components/VirtualMessageList.tsx')
  const keyLaw = read('src/components/virtualListKeys.ts')
  check('the list still appends in place (the identity law the map now honours)', list.includes('reconcileItemKeys(keysStateRef.current, messages, itemKey)') && keyLaw.includes('keys.push(key)') && keyLaw.includes('if (keys === prior.keys) {'))
  check('the content pin still resolves through the one index (the consumer the fix revives)', hook.includes('const idx = indexByKey(itemKeys, pin.key)') && hook.includes('box.pinScrollTop(target)'))
  const model = (): { index: (keys: readonly string[], key: string) => number | undefined } => {
    const ki = { keys: null as readonly string[] | null, map: new Map<string, number>(), indexed: 0 }
    return {
      index: (keys, key) => {
        if (ki.keys !== keys) {
          ki.map.clear()
          for (let i = 0; i < keys.length; i++) ki.map.set(keys[i]!, i)
          ki.keys = keys
          ki.indexed = keys.length
        } else if (ki.indexed < keys.length) {
          for (let i = ki.indexed; i < keys.length; i++) ki.map.set(keys[i]!, i)
          ki.indexed = keys.length
        }
        return ki.map.get(key)
      },
    }
  }
  const m = model()
  const keys: string[] = ['a', 'b']
  check('model: a key present at the first build resolves', m.index(keys, 'b') === 1)
  keys.push('c')
  check('model: a key appended in place resolves (the finding: it was undefined)', m.index(keys, 'c') === 2)
  const fresh = ['x', 'y']
  check('model: a new identity rebuilds and forgets the old keys', m.index(fresh, 'y') === 1 && m.index(fresh, 'c') === undefined)
}

process.exit(failures === 0 ? 0 : 1)
