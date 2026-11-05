import { ADAPTER_FLAG } from '../services/tensorfold/adapter/identity.js'
import { runTensorFoldAdapter } from '../services/tensorfold/adapter/main.js'

const args = process.argv.slice(2)
const code = await runTensorFoldAdapter(args[0] === ADAPTER_FLAG ? args.slice(1) : args)
if (code !== 0) process.exitCode = code
