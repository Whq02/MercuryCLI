import { notBuilt, unbuilt, type Unbuilt } from '../../pi/holes.js'

export const compactWarningStore: Unbuilt = unbuilt('src/services/compact/compactWarningState.ts:11')

export function suppressCompactWarning(): void {
  return notBuilt('src/services/compact/compactWarningState.ts:23')
}

export function clearCompactWarningSuppression(): void {
  return notBuilt('src/services/compact/compactWarningState.ts:30')
}
