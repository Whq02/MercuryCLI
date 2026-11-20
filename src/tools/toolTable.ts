import type { assembleToolPool } from '../tools.js'

type AssemblesAToolPool = typeof assembleToolPool

let howAToolPoolIsAssembled: AssemblesAToolPool | undefined

export function tellHowAToolPoolIsAssembled(assemble: AssemblesAToolPool): void {
  howAToolPoolIsAssembled = assemble
}

export const toolPoolOfTheTable: AssemblesAToolPool = (...call) => howAToolPoolIsAssembled!(...call)
