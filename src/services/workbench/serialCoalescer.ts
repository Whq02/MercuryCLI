
import { serialGenerationLane } from '../../substrate/serialGeneration.js'

export interface SerialCoalescer {
  poke: () => void
  settled: () => Promise<void>
  release: () => void
  generation: () => number
}

const REQUEST = 'run' as const

export function serialCoalescer(
  run: () => Promise<void>,
  name = 'coalescer',
): SerialCoalescer {
  let released = false

  const lane = serialGenerationLane<typeof REQUEST>({
    name,
    commit: async () => {
      if (released) return
      await run()
    },
  })

  return {
    poke: () => {
      if (released) return
      lane.accept(REQUEST)
      lane.poke()
    },
    settled: async () => {
      await lane.settle()
    },
    release: () => {
      released = true
      void lane.release()
    },
    generation: () => lane.state().accepted,
  }
}
