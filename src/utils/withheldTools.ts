import { debugToolWithholding } from '../services/dap/dapClient.js'
import { resolveDesktopDriver } from '../services/desktop/resolveDriver.js'
import { flagEnabled } from '../substrate/flagRegistry.js'
import { searchToolsAvailability } from './ripgrep.js'
import { godotToolWithholding } from './vulcan/vulcanGates.js'

export interface WithheldTool {
  tool: string
  dependency: string
  why: string
  remedy?: string
}

export const CATALOG_MACHINE_DEPENDENCIES =
  'a debug adapter (Debug), a Godot executable (Godot), the desktop driver (Computer), the search binary (Grep and Glob)'

export function withheldTools(): WithheldTool[] {
  const out: WithheldTool[] = []
  const debug = debugToolWithholding()
  if (debug.withheld) out.push({ tool: 'Debug', dependency: 'a debug adapter', why: debug.why, remedy: debug.remedy })
  const godot = godotToolWithholding()
  if (godot.withheld) out.push({ tool: 'Godot', dependency: 'a Godot executable', why: godot.why, remedy: godot.remedy })
  if (flagEnabled('MERCURY_COMPUTER_USE')) {
    const driver = resolveDesktopDriver()
    if (driver.state === 'unavailable') {
      out.push({ tool: 'Computer', dependency: 'the desktop driver', why: driver.note, ...(driver.remedy !== null ? { remedy: driver.remedy } : {}) })
    }
  }
  const search = searchToolsAvailability()
  if (!search.available) {
    out.push({
      tool: 'Grep and Glob',
      dependency: 'the search binary',
      why: 'no search binary — neither the vendored ripgrep nor an rg on PATH',
      ...(search.remedy !== undefined ? { remedy: search.remedy } : {}),
    })
  }
  return out
}

export function withheldToolsLine(list: readonly WithheldTool[] = withheldTools()): string {
  if (list.length === 0) return `no tool is withheld — every machine dependency the catalog checks is present: ${CATALOG_MACHINE_DEPENDENCIES}`
  return `${list.length} withheld from the catalog: ${list.map(w => `${w.tool} — ${w.why}`).join(' · ')}`
}
