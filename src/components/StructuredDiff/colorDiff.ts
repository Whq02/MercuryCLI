import { ColorDiff, ColorFile, type SyntaxTheme } from 'color-diff-napi'
import { notBuilt, type Unbuilt } from '../../pi/holes.js'

type ColorModuleUnavailableReason = Unbuilt

export function getColorModuleUnavailableReason(): ColorModuleUnavailableReason | null {
  return notBuilt('src/components/StructuredDiff/colorDiff.ts:11')
}

export function expectColorDiff(): typeof ColorDiff | null {
  return notBuilt('src/components/StructuredDiff/colorDiff.ts:15')
}

export function expectColorFile(): typeof ColorFile | null {
  return notBuilt('src/components/StructuredDiff/colorDiff.ts:22')
}

export function getSyntaxTheme(themeName: string): SyntaxTheme | null {
  return notBuilt('src/components/StructuredDiff/colorDiff.ts:27')
}
