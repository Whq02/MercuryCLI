import * as React from 'react'
import { RealmsView } from '../../components/mercury-ui/parity/RealmsView.js'
import {
  addRealm,
  cloneRealm,
  revokeRealm,
} from '../../utils/realmRegistry.js'
import type { LocalJSXCommandCall } from '../../types/command.js'


function Report({ message, onDone }: { message: string; onDone: (msg?: string) => void }): React.ReactNode {
  React.useEffect(() => {
    onDone(message)
  }, [message, onDone])
  return null
}

function ApplyClone({ source, target, onDone }: { source: string; target?: string; onDone: (msg?: string) => void }): React.ReactNode {
  React.useEffect(() => {
    let alive = true
    void cloneRealm(source, target).then(res => {
      if (alive) onDone(res.ok ? res.message : res.reason)
    })
    return () => {
      alive = false
    }
  }, [source, target, onDone])
  return null
}

export const call: LocalJSXCommandCall = async (onDone, _context, args) => {
  const argv = (args ?? '').trim()
  if (argv) {
    const [verb = '', ...rest] = argv.split(/\s+/)
    switch (verb.toLowerCase()) {
      case 'add': {
        const path = rest.join(' ')
        if (!path) return <Report message="usage: /realms add <path>" onDone={onDone} />
        const res = addRealm(path)
        return <Report message={res.ok ? res.message : res.reason} onDone={onDone} />
      }
      case 'revoke':
      case 'remove': {
        const key = rest.join(' ')
        if (!key) return <Report message="usage: /realms revoke <name>" onDone={onDone} />
        const res = revokeRealm(key)
        return <Report message={res.ok ? res.message : res.reason} onDone={onDone} />
      }
      case 'clone': {
        const [source] = rest
        const target = rest.length > 1 ? rest.slice(1).join(' ') : undefined
        if (!source) return <Report message="usage: /realms clone <github-url|owner/repo> [path]" onDone={onDone} />
        return <ApplyClone source={source} target={target} onDone={onDone} />
      }
      default:
        return <Report message={`unknown /realms verb '${verb}' — add · revoke · clone (bare /realms opens the panel)`} onDone={onDone} />
    }
  }
  return <RealmsView onClose={(value?: unknown, options?: Parameters<typeof onDone>[1]) => { const v = typeof value === 'string' ? value : undefined; onDone(v, options ?? (v === undefined ? { display: 'skip' } : undefined)) }} />
}
