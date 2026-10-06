import type { LocalJSXCommandCall } from '../../types/command.js'
import { openCrewView } from '../../utils/cockpit/crewView.js'

export const call: LocalJSXCommandCall = async onDone => {
  openCrewView()
  onDone(undefined, { display: 'skip' })
  return null
}
