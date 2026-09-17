import { SandboxManager, convertToSandboxRuntimeConfig } from '../../../../src/utils/sandbox/sandbox-adapter.ts'

const check = SandboxManager.checkDependencies()
const config = convertToSandboxRuntimeConfig({})
process.stdout.write(
  JSON.stringify({
    platform: process.platform,
    check,
    bwrapPath: config.bwrapPath,
    socatPath: config.socatPath,
    ripgrep: config.ripgrep,
    seccomp: config.seccomp,
  }) + '\n',
)
