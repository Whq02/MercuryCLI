import { validateSessionKit, type SessionKitV1 } from '../../daemon/sessionKit.js'
import { setNextSessionFacts } from '../switchboard/bootBirthFacts.js'
import { kitRowView, type KitRow, type KitStates } from './kitTypes.js'

export function resolvedKitOf(rows: readonly KitRow[], states: KitStates): SessionKitV1 {
  const kit: SessionKitV1 = { schema: 1, mcp: [], skills: [], invocable: [] }
  const extensions: Record<string, 'on' | 'off'> = {}
  for (const row of rows) {
    if (row.kind === 'mcp') {
      if (kitRowView(row, states).effective === 'on' && !kit.mcp.includes(row.name)) kit.mcp.push(row.name)
    } else if (row.kind === 'skill') {
      const effective = kitRowView(row, states).effective
      if (effective === 'on' && !kit.skills.includes(row.name)) kit.skills.push(row.name)
      else if (effective === 'invocable' && !kit.invocable.includes(row.name)) kit.invocable.push(row.name)
    } else if (row.kind === 'extension') {
      extensions[row.name] = kitRowView(row, states).own === 'off' ? 'off' : 'on'
    }
  }
  if (Object.keys(extensions).length > 0) kit.extensions = extensions
  return kit
}

export type KitCarryReceipt = { carried: true } | { carried: false; reason: string }

export function carryNextSessionKit(rows: readonly KitRow[], states: KitStates): KitCarryReceipt {
  const validation = validateSessionKit(resolvedKitOf(rows, states))
  if (!validation.ok) return { carried: false, reason: validation.reason }
  setNextSessionFacts({ kit: validation.kit })
  return { carried: true }
}
