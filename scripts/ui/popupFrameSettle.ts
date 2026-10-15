import { waitFor, type Mounted } from '../lib/settingsPopupHarness.ts'

export async function settledFrame(scene: Mounted, ready: (frame: string) => boolean = frame => frame.trim() !== '', ms = 4000): Promise<boolean> {
  let previous: string | undefined
  const settled = await waitFor(() => {
    const frame = scene.screen()
    const settled = ready(frame) && frame === previous
    previous = ready(frame) ? frame : undefined
    return settled
  }, ms)
  if (!settled) throw new Error(`frame never settled for ${ready.toString()}\n${scene.screen()}`)
  return true
}
