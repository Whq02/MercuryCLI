process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { remoteRun } = await import('../../src/services/remoteFiles/connection.ts')

const reply = await remoteRun({ host: 'box' }, { script: 'printf %s $$' })
process.stdout.write(`${reply.stdout.toString()}\n`, () => process.kill(process.pid, 'SIGKILL'))
