import { ADAPTER_FLAG } from '../../models/tensorfold/adapter/identity.js'
import { runTensorFoldAdapter } from '../../models/tensorfold/adapter/main.js'

const args = process.argv.slice(2)
const code = await runTensorFoldAdapter(args[0] === ADAPTER_FLAG ? args.slice(1) : args)
if (code !== 0) process.exitCode = code
