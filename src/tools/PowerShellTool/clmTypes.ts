import { notBuilt } from '../../pi/holes.js'

function normalizeTypeName(name: string): string {
  let out = name.toLowerCase().trim()
  out = out.replace(/\[\s*\]$/, '')
  out = out.replace(/\[[^\]]*\]$/, '')
  return out.trim()
}

export function isClmAllowedType(typeName: string): boolean {
  return notBuilt('src/tools/PowerShellTool/clmTypes.ts:53')
}
