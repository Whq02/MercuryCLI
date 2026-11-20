
import { projectIntelEnabled } from '../../utils/projectIntel/contracts.js'
import { passedOver } from '../../utils/passedOver.js'

function refsOn(): boolean {
  try {
    const { mercuryRefsEnabled } =
      require('../resources/contracts.js') as typeof import('../resources/contracts.js')
    return mercuryRefsEnabled()
  } catch (error) {
    passedOver(error)
    return false
  }
}

export function readSteeringLine(): string | null {
  if (!projectIntelEnabled() || !refsOn()) return null
  return ' Orientation shortcut: before opening files one by one to learn a repo, Inspect mercury://project/current (topology · changes · checks · a task-scoped working set via ?child=context&q=<task>).'
}
