
import type ScreenInstance from './screenInstance.js'

const instances = new Map<NodeJS.WriteStream, ScreenInstance>()
export default instances
