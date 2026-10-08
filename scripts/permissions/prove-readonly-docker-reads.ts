#!/usr/bin/env bun
// gate-watch: src/tools/BashTool/readOnlyValidation.ts src/utils/shell/readOnlyCommandValidation.ts
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'readonly-docker-')))
mkdirSync(join(scratch, 'plain'))
mkdirSync(join(scratch, 'home'))
const previousCwd = process.cwd()
process.chdir(join(scratch, 'plain'))
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { checkReadOnlyConstraints, describeBashNotReadOnly, notReadOnlyClause } = await import('../../src/tools/BashTool/readOnlyValidation.js')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

const readsOnly = (command: string, cd = false): boolean => checkReadOnlyConstraints({ command }, cd).behavior === 'allow'

const READS = [
  'docker ps',
  'docker ps -a',
  'docker ps -aq',
  'docker ps --filter status=running --format "{{.Names}}"',
  'docker ps --no-trunc --size',
  'docker images',
  'docker images -q',
  'docker images --digests --no-trunc',
  'docker images --filter dangling=true',
  'docker logs web',
  'docker logs --tail 50 web',
  'docker logs -f --since 10m web',
  'docker inspect web',
  'docker inspect --format "{{.Id}}" web',
  'docker inspect -s --type container web',
  'docker ps | grep web',
  'docker images | wc -l',
  'docker logs web 2>&1',
]

const WRITES = [
  'docker run -it ubuntu bash',
  'docker run --rm -v /:/host alpine sh',
  'docker exec -it web sh',
  'docker rm -f web',
  'docker rmi image',
  'docker build -t x .',
  'docker compose up -d',
  'docker compose down',
  'docker cp web:/etc/passwd ./passwd',
  'docker kill web',
  'docker stop web',
  'docker start web',
  'docker restart web',
  'docker pull alpine',
  'docker push registry/image',
  'docker system prune -af',
  'docker volume rm data',
  'docker network rm net',
  'docker commit web image',
  'docker login registry',
  'docker ps && docker rm web',
  'docker images | xargs docker rmi',
]

console.log('1. the four docker reads are read-only, with their flags, in a pipe and beside a cd')
for (const command of READS) {
  check(`read-only: ${command}`, readsOnly(command))
  check(`read-only beside a cd: ${command}`, readsOnly(command, true))
}

console.log('2. every other docker verb asks: it runs, changes or removes something the read-only list cannot vouch for')
for (const command of WRITES) {
  check(`asks: ${command}`, !readsOnly(command))
}

console.log('3. the refusal names docker and its form')
for (const command of ['docker run -it ubuntu bash', 'docker rm -f web', 'docker exec -it web sh']) {
  const reason = describeBashNotReadOnly(command)
  check(`the reason for ${JSON.stringify(command)} is a form refusal naming docker`, reason !== null && reason.kind === 'form' && reason.word === 'docker', JSON.stringify(reason))
  check(`its clause says so`, reason !== null && notReadOnlyClause(reason) === 'it is not a read-only form of `docker`', reason === null ? 'null' : notReadOnlyClause(reason))
}

console.log('4. a docker read with a shell expansion or an unknown flag is not vouched for')
for (const command of ['docker ps $(cat x)', 'docker logs $NAME', 'docker ps --wipe', 'docker inspect --unknown web']) {
  check(`asks: ${command}`, !readsOnly(command))
}

process.chdir(previousCwd)
rmSync(scratch, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-readonly-docker-reads: ALL LAWS HOLD' : `\nprove-readonly-docker-reads: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
