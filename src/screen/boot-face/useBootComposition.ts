import { useMemo } from 'react'
import type { BootMenuData, SplashCore } from '../../../assets/splash/splash-core.mjs'

export function useBootComposition(core: SplashCore, columns: number, rows: number, menuM: BootMenuData): { placed: string[]; entryAt: Map<number, number> } {
  return useMemo(() => {
    const menu = core.composeBootMenu(columns, rows, menuM)
    const { placed, top } = core.placeBlock(menu.lines, rows)
    return {
      placed,
      entryAt: new Map<number, number>(menu.entryLines.map(e => [e.line + top, e.entry])),
    }
  }, [core, columns, rows, menuM])
}
