// kill child — one durableAtomicPublish under a parent-set
// MERCURY_FAULT_INJECT kill point (the abrupt-death shape at an exact phase).
import { durableAtomicPublish } from '../../../src/substrate/durablePublish.ts'

const target = process.env.RELIA_TARGET
if (!target) throw new Error('RELIA_TARGET required')
await durableAtomicPublish(target, process.env.RELIA_CONTENT ?? 'new-bytes')
process.exit(0)
