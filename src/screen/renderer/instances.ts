
import type Ink from './screenInstance.js'

const instances = new Map<NodeJS.WriteStream, Ink>()
export default instances
