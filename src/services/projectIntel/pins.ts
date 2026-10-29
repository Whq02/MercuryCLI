
import { OwnerScopedStore, type OwnerKey } from '../primitives/owner.js'

interface ContextMarks {
  pins: Set<string>
  drops: Set<string>
}

const marks = new OwnerScopedStore<ContextMarks>({
  name: 'project-intel-marks',
  create: () => ({ pins: new Set(), drops: new Set() }),
  cap: 32,
})

export function getContextMarks(owner: OwnerKey): { pins: string[]; drops: string[] } {
  const m = marks.get(owner)
  return { pins: [...m.pins].sort(), drops: [...m.drops].sort() }
}
