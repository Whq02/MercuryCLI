import { BootSaturnScreen } from '../../screen/boot-face/BootSaturnScreen.js'
import type { LocalJSXCommandCall } from '../catalogue/command.js'

export const call: LocalJSXCommandCall = async onDone => {
  return <BootSaturnScreen onClose={(value?: string) => onDone(value, value === undefined ? { display: 'skip' } : undefined)} />
}
