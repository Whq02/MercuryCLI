#!/usr/bin/env bun
import { ADAPTER_FLAG } from '../../../src/services/tensorfold/adapter/identity.ts'
import { runTensorFoldAdapter } from '../../../src/services/tensorfold/adapter/main.ts'

const ramBytes = Number(process.env.FAKE_ADAPTER_RAM_BYTES)
if (!(ramBytes > 0)) {
  process.stderr.write('the fixture\'s adapter entry starts nothing without FAKE_ADAPTER_RAM_BYTES, the memory of the machine it stands on\n')
  process.exit(2)
}
const args = process.argv.slice(2)
const code = await runTensorFoldAdapter(args[0] === ADAPTER_FLAG ? args.slice(1) : args, { ramBytes })
if (code !== 0) process.exitCode = code
