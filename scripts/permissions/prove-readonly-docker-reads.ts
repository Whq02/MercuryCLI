#!/usr/bin/env bun
// gate-watch: src/tools/BashTool/readOnlyValidation.ts src/utils/shell/readOnlyCommandValidation.ts src/tools/PowerShellTool/readOnlyValidation.ts src/tools/AgentTool/scoutPolicy.ts src/tools/BashTool/BashTool.tsx
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

const readsOnly = async (command: string, cd = false): Promise<boolean> => (await checkReadOnlyConstraints({ command }, cd)).behavior === 'allow'

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
  check(`read-only: ${command}`, (await readsOnly(command)))
  check(`read-only beside a cd: ${command}`, await readsOnly(command, true))
}

console.log('2. every other docker verb asks: it runs, changes or removes something the read-only list cannot vouch for')
for (const command of WRITES) {
  check(`asks: ${command}`, !(await readsOnly(command)))
}

console.log('3. the refusal names docker and its form')
for (const command of ['docker run -it ubuntu bash', 'docker rm -f web', 'docker exec -it web sh']) {
  const reason = await describeBashNotReadOnly(command)
  check(`the reason for ${JSON.stringify(command)} is a form refusal naming docker`, reason !== null && reason.kind === 'form' && reason.word === 'docker', JSON.stringify(reason))
  check(`its clause says so`, reason !== null && notReadOnlyClause(reason) === 'it is not a read-only form of `docker`', reason === null ? 'null' : notReadOnlyClause(reason))
}

console.log('4. a docker read with a shell expansion or an unknown flag is not vouched for')
for (const command of ['docker ps $(cat x)', 'docker logs $NAME', 'docker ps --wipe', 'docker inspect --unknown web']) {
  check(`asks: ${command}`, !(await readsOnly(command)))
}

console.log('5. PowerShell reads the same four forms through the same flag tables')
const { isAllowlistedCommand } = await import('../../src/tools/PowerShellTool/readOnlyValidation.js')
const psReadsOnly = (command: string): boolean => {
  const [name, ...args] = command.split(' ')
  return isAllowlistedCommand(
    { name: name as string, text: command, nameType: 'unknown', args, elementTypes: args.map(arg => (arg.startsWith('-') ? 'Parameter' : 'StringConstant')), elementType: 'CommandAst' },
    command,
  )
}
for (const command of ['docker ps', 'docker ps -a', 'docker images -q', 'docker logs --tail 50 web', 'docker inspect web']) {
  check(`PowerShell read-only: ${command}`, psReadsOnly(command))
}
for (const command of ['docker', 'docker run -it ubuntu bash', 'docker rm -f web', 'docker exec -it web sh', 'docker ps --wipe', 'docker images --unknown']) {
  check(`PowerShell asks: ${command}`, !psReadsOnly(command))
}

console.log('6. the shape of the words never widens the read: spacing, case, a path to docker, a wrapper, a global flag, a substitution, a separator')
const SHAPED_READS = [
  'docker  ps',
  'docker\tps',
  'docker\t\tlogs\tweb',
  'docker ps \\\n -a',
  'docker "ps"',
  "docker 'ps'",
  'docker inspect --format={{.Id}} web',
  'docker ps --filter=status=running',
  'docker logs --tail=50 web',
  'docker ps && docker ps',
  'cd /tmp && docker ps',
  'docker logs web >/dev/null',
  'docker logs web 2>/dev/null',
]
for (const command of SHAPED_READS) check(`read-only: ${JSON.stringify(command)}`, await readsOnly(command, command.startsWith('cd ')))
const SHAPED_ASKS = [
  'docker ps;rm -rf x',
  'docker ps\ndocker rm web',
  'docker ps -a; docker rm web',
  'docker ps&&docker rm web',
  'docker ps||docker rm web',
  'docker ps & docker rm web',
  'docker images; docker rmi x',
  'DOCKER ps',
  'docker.exe ps',
  'dockerd',
  'docker-compose up',
  '/usr/bin/docker ps',
  '/usr/bin/docker run -it ubuntu bash',
  'env docker run -it ubuntu bash',
  'timeout 5 docker run -it ubuntu bash',
  'nice docker exec -it web sh',
  'sudo docker ps',
  'DOCKER_HOST=tcp://evil:2375 docker ps',
  'docker --host tcp://evil:2375 ps',
  'docker -H tcp://evil:2375 ps',
  'docker --context evil ps',
  'docker --config /x ps',
  'docker -D ps',
  "docker ps --format '{{.Names}}' | xargs docker rm",
  'docker ps -a|xargs docker rm',
  'docker ps -q | xargs docker stop',
  'docker logs $(cat x)',
  "docker inspect --format '{{.Mounts}}' $(docker ps -q)",
  'docker inspect `docker ps -q`',
  'docker ps `rm x`',
  'docker ${X} ps',
  'docker inspect $CONTAINER',
  'docker ps --filter "name=$(whoami)"',
  "docker 'rm' web",
  'docker "rm" web',
  "docker r'm' web",
  'docker inspect web --format "{{.Id}}" --rm',
  'docker container ls',
  'docker image ls',
  'docker logs web | sh',
  'docker ps | tee /tmp/x',
  'docker ps > /etc/x',
  'docker logs web > out.txt',
  'docker logs -f web &',
  'docker ps >(cat)',
  'docker ps <(cat)',
  'echo $(docker ps)',
  'docker\nps',
]
for (const command of SHAPED_ASKS) check(`asks: ${JSON.stringify(command)}`, !(await readsOnly(command)))

console.log('7. the read-only scout refuses the same forms and runs the same reads')
delete process.env.NODE_ENV
const { enableConfigs } = await import('../../src/utils/config.js')
enableConfigs()
await import('../../src/Tool.js')
const { scoutRefusal } = await import('../../src/tools/AgentTool/scoutPolicy.js')
const { BashTool } = await import('../../src/tools/BashTool/BashTool.js')
const scoutRuns = async (command: string): Promise<boolean> => await scoutRefusal(BashTool as never, { command }) === null
for (const command of [...READS, ...SHAPED_READS]) check(`scout runs: ${JSON.stringify(command)}`, await scoutRuns(command))
for (const command of [...WRITES, ...SHAPED_ASKS]) check(`scout refuses: ${JSON.stringify(command)}`, !(await scoutRuns(command)))
for (const command of ['docker run -it ubuntu bash', 'docker --host tcp://evil:2375 ps', 'docker ps\ndocker rm web']) {
  const words = await scoutRefusal(BashTool as never, { command })
  check(`the scout's refusal of ${JSON.stringify(command)} names docker's form`, words !== null && words.includes('is not a read-only form of `docker`'), words ?? 'null')
}

console.log('8. PowerShell resolves the name as Windows does and refuses the same global flags and expansions')
for (const command of ['DOCKER ps', 'docker.exe ps', 'Docker.EXE images -q', 'docker PS', 'docker inspect --format {{.Id}} web', 'docker ps -a -q']) {
  check(`PowerShell read-only: ${command}`, psReadsOnly(command))
}
for (const command of ['docker.exe rm web', 'docker RM web', 'docker logs $env:NAME', 'docker ps --format $x', 'docker --host tcp://evil:2375 ps', 'docker -H tcp://evil:2375 ps', 'docker --context evil ps', 'docker container ls', 'docker image ls', 'docker compose ps', 'C:\\Program Files\\Docker\\docker.exe ps', '.\\docker.exe ps']) {
  check(`PowerShell asks: ${command}`, !psReadsOnly(command))
}

process.chdir(previousCwd)
rmSync(scratch, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-readonly-docker-reads: ALL LAWS HOLD' : `\nprove-readonly-docker-reads: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
