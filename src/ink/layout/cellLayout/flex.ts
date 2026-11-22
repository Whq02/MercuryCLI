import { notBuilt, type Unbuilt } from '../../../pi/holes.js'

type Flexible = Unbuilt

export function resolveFlexibleLengths<N extends Flexible>(
  line: Array<{ node: N; basis: number; targetMain: number }>,
  flexAvail: number | undefined,
  lineBasis: number,
  clampMain: (c: N, v: number) => number,
): void {
  return notBuilt('src/ink/layout/cellLayout/flex.ts:3')
}
