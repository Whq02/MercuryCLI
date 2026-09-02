import { durableAtomicPublish } from '../../../src/substrate/durablePublish.ts'

const target = process.env.RELIA_TARGET
if (!target) throw new Error('RELIA_TARGET required')
await durableAtomicPublish(target, process.env.RELIA_CONTENT ?? 'new-bytes')
process.exit(0)
