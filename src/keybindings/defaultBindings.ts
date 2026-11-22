import { satisfies } from 'semver'
import type { ActionGraph } from './actionGraph.js'
import type { KeybindingBlock } from './types.js'
import { unbuilt, type Unbuilt } from '../pi/holes.js'

type GraphAction = keyof ActionGraph
type GraphContext = ActionGraph[GraphAction]['contexts'][number]
type BoundIn<Context extends GraphContext> =
  | { [Action in GraphAction]: Context extends ActionGraph[Action]['contexts'][number] ? Action : never }[GraphAction]
  | `command:${string}`
type ShippedRows = { [Context in GraphContext]?: Record<string, BoundIn<Context>> }

const VT_MODE_FLOORS = { bun: '>=1.2.23', node: '>=22.17.0 <23.0.0 || >=24.2.0' } as const

type HostChords = { modeCycle: string; imagePaste: string; copyRows: Record<string, BoundIn<'Scroll'>> }

function hostChords(platform: NodeJS.Platform, versions: NodeJS.ProcessVersions): HostChords {
  const windows = platform === 'win32'
  const consoleHasVtMode = (): boolean => (versions.bun ? satisfies(versions.bun, VT_MODE_FLOORS.bun) : satisfies(versions.node, VT_MODE_FLOORS.node))
  return {
    modeCycle: !windows || consoleHasVtMode() ? 'shift+tab' : 'meta+m',
    imagePaste: windows ? 'alt+v' : 'ctrl+v',
    copyRows: platform === 'darwin' ? { 'cmd+c': 'selection:copy' } : {},
  }
}

const HOST = hostChords(process.platform, process.versions)

const SELECT_LIST_KEYS = {
  wheel: { wheelup: 'select:previous', wheeldown: 'select:next' },
  ctrlPrevNext: { 'ctrl+p': 'select:previous', 'ctrl+n': 'select:next' },
  ends: { home: 'select:first', end: 'select:last' },
} as const satisfies Record<string, Record<string, BoundIn<'Settings'> & BoundIn<'Select'>>>

const SHIPPED_KEYS: Unbuilt = unbuilt('src/keybindings/defaultBindings.ts:34')

export const DEFAULT_BINDINGS: KeybindingBlock[] = Object.entries(SHIPPED_KEYS).map(([context, bindings]) => ({ context, bindings }))
