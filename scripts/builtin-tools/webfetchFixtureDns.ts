import { mock } from 'bun:test'
import * as dns from 'node:dns/promises'

const original = { ...dns }
mock.module('node:dns/promises', () => ({
  ...original,
  lookup: async (_host: string, options?: { all?: boolean }) => options?.all
    ? [{ address: '127.0.0.1', family: 4 }]
    : { address: '127.0.0.1', family: 4 },
}))
