#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const updateService = (await import('../../src/services/privateChannel/updateService.ts')) as {
  extractorEnv?: (shell: string, archivePath: string, destDir: string) => NodeJS.ProcessEnv
}

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
const spellings = (env: NodeJS.ProcessEnv, name: string): string[] =>
  Object.keys(env).filter(key => key.toUpperCase() === name.toUpperCase())

console.log('============================================================')
console.log(' the update extractor environment per PowerShell edition')
console.log('============================================================')

check('updateService exports extractorEnv', typeof updateService.extractorEnv === 'function')

if (typeof updateService.extractorEnv === 'function') {
  process.env.PSModulePath = ['pwsh-user-modules', 'pwsh-shared-modules'].join(process.platform === 'win32' ? ';' : ':')
  const legacy = updateService.extractorEnv('powershell', 'archive.zip', 'dest')
  const modern = updateService.extractorEnv('pwsh', 'archive.zip', 'dest')
  check('Windows PowerShell gets no inherited module path, so it builds its own', spellings(legacy, 'PSModulePath').length === 0, spellings(legacy, 'PSModulePath').join(', '))
  check('PowerShell 7 keeps the module path it inherited', spellings(modern, 'PSModulePath').length === 1)
  check('both carry the archive and the destination', legacy.MERCURY_UPDATE_ARCHIVE === 'archive.zip' && legacy.MERCURY_UPDATE_DEST === 'dest' && modern.MERCURY_UPDATE_ARCHIVE === 'archive.zip')
  check('both keep PATH', spellings(legacy, 'PATH').length === 1 && spellings(modern, 'PATH').length === 1)
  delete process.env.PSModulePath
}

console.log(failures === 0 ? '\nALL UPDATE EXTRACTOR ENV CHECKS PASS' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
