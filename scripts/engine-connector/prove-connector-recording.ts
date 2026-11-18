#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import ts from 'typescript'
import { LISTENER_KINDS, type Recording } from './connectorScenarios.ts'

const ROOT = resolve(import.meta.dir, '..', '..')
const SCENARIOS = join(ROOT, 'scripts', 'engine-connector', 'connectorScenarios.ts')
const CONNECTOR = join(ROOT, 'src', 'services', 'engine-connector', 'daemonConnector.ts')
const SELF = 'scripts/engine-connector/prove-connector-recording.ts'

const RECORDED: Readonly<Record<string, { whole: string; events: string }>> = {
  'attach-and-detach': {
    whole: 'de13e080bbf2f9249334e24ae51bda565a8a1b495a6775e819cbee054ac315e1',
    events: 'ad862a1d6ff2552a6ed8e4511fc4b8ed2a1d1fc4c847ccc5171466b817142fadc847ccc517142fadc717',
  },
  'send-delivered': {
    whole: 'c3c327684e8608c2d3a609c4d1ce4380c0fc0aac13d4e89ec0b6c52bfc626f9f',
    events: '93dc80872f3ed71efb2c1759552a132f552aa5ad4693deb2d83646939a7c0722dfe0d70f47d84513abb8b8c10405f6aadca961cc4693015fcd3407223502d71e1cfd47d8673347d8171466b872b0',
  },
  'send-queued-then-recalled': {
    whole: '17c15b433573cb9491e759df2a9f443405ebb2fd06417b5220675a866bd24843',
    events: '4ca080872f3e491c571e47d81759552a4005552a643c4693deb2df980ac69a7c0988762a47d85ff03fccbd34469301045ff0517cddf9552ad02c469343040ac69a7c32ed47d874d152a6c39e74d1ceacd73217dc74d113ec8e5474d1c006bd344693e1a9db18552adea146936fa20ac69a7cb417aa346452203bb417203bd293552afe3c46930c810ac69a7cf72d3eb9aacd46932844e7fa517c171466b846cd',
  },
  'send-refused-held-failed': {
    whole: '1d49fd6de235965a33fbc835e349a7aaafd8b0bd7b82c3e933a186f5223126f3',
    events: 'c08880872f3e6006fb2c1759552a289ad9054638d90504d2552a34e34693deb2670e37c446939fd704d2552a34e346931ba146939a7c484a552a8c3f4693706d34e34693c2f7d6b4552a07144693de6034e34693eb5017dc3e40552a5dfe4693deb234e34693b3838e54e6ea552a54a44693deb27d0846939a7c579b552a6b274693deb25b9246939a7c25f8552a09044693deb2344646939a7c5c4c552a3be44693deb2c7d04693bdea560d552add054693deb279e73be446934aeb8d92deb297e3d0033e64a89f2ff9a89f52bbdeb2e3287518c013deb26fe886b817dc6d28deb2c29f8e5417142d705b6a',
  },
  'asks-answered-and-settled': {
    whole: '2e86bd6f153f31b7736fe25d4859003a5d9f2a872735fcb13498712fdae2b85f',
    events: '5d0780872f3e560afbf59b6f34bdfb2147d8175959916fe815da5991042a65fb9a7bb6973ca9e2eba51dc169b6f5b69772877a40f3e3c1696597b697552af3264693deb20fa90ac6fc173e1777a6ac11818477a68184c8fa04aae5ed6fac47528dd8c0bac169cdbe7f7ee36417dc4100c16909188e54d379604a600607ebbaf747d8cc59c169af4571d5a847e3d5a13a171466b872b0',
  },
  'interrupt-mid-turn': {
    whole: '3febf39d55242d88bd633137e06eaef8e3682f905a856cf2601d70c4055f6a6f',
    events: '25fb80872f3ecc59696d44d0556fc79234bd52d447d81759c3b7f5f2d154cc593ae9d718469371d5db2ef265ba0bcc593ae946d971d5b0b6cc593ae971d59c2ce4b86006721047d8957d9c2c8794743c5de21ca8ae3247d8afeb6d093df6cc593ae9d718469371d50861f49fb88e051717dccc593ae9d718469371d5f49f8e5462792582cc593ae9623371d55aae2c7a22e6469360067cc547d8171466b87399',
  },
  'rewind': {
    whole: 'f155ce72e137c9ee9de2d165821c46f1a1a845d69e44017fa0af8c433c2d1dac',
    events: 'de2b80872f3e9903eb9863547cc447d8175983e6bb498f71fb88dfac3499f7db01fd7b8c8a7d2b4ba09e991047dd6bac7880405b2a87865ad5568c714f0dd55685ebec0bd556e3a77521d55660c15d4fd55613e20ca917dcd556fbe38e546006b39b47d8171466b87399',
  },
  'fold-and-its-exit': {
    whole: 'dd44419b1cc195bdffdaba98dcd4da268e96cd718d99c15e138f8760c6b86e8c',
    events: 'cdf880872f3e6839d67447d81759552aba4a2c99dbfa84fd552ac6c74693deb22117980f46939a7c28e2051347d8f0afb9c928a604b067517ed88d90aa5b46934693469346934693033f8781c38cb92d4d7dab2be893c38c7ed8b92df2544693469346934693469387818a31ab2b150706a8b92d81df47d8f25487818fea8a5dcf2247d8e05604bc251dd71e8781f11047d874c69be247668781e28eb92d171466b872b0',
  },
  'model-and-effort': {
    whole: 'cf363d09b16830a4fd5ec37d1818ad5b00f4e40041f5454f5c8efa0474406d1b',
    events: 'fa95dde5d93133df6006fb2c1759552abc6144834d1333dfdde5b622047d47d8b198b98dc7464483a04cc02eff4947d8dde5774f001413e1ac092fbb47d83567d4ce841e47d80831e121b05a4483ec160831e12156bb4483a1140831e12190f9448313e10831e1216548b6220831b622047d44830831e121a9cb44830b8717dc0831e1214483b0808e54e222437afac8ed88e2222ffd3620f41547d87f7c7c57b8e4297550a0469347d8ed882975f240469347d80c0829756593469347d8e3e02975315c469347d82ffd29756385469347d876b617dc2975469347d835658e5479279ffb17142fad7399',
  },
  'permission-mode': {
    whole: '7e6fa4e4408ffddd04898ed4fc776874bc3324d44720e6254f14c437b49c9942',
    events: '1bceb79864b598e66006fb2c1759552ab798939cd824090bbcf347d8b79817593e24c9d725a77746de8b939c47d8b523bfb6d6f583c0939c47d876e117dcbfb6d6f5939c47d85ac08e547996d6f547d8792717142fad7399',
  },
  'carrier-gone-and-back': {
    whole: 'dc4b57011ab5810dd536acfc0f24920064a97ddebc65c6c48990ca57d82a2d97',
    events: '1ce580872f3e6df4bf0554d60cf0a28247d81759db576fc9606f615c51b4bae42da6615c673347d8b57e70d447d87689615c51b4b9a862c42133171466b87399',
  },
  'transcript-unreadable': {
    whole: '85a1d3f9f9287433da5ed0aa682199a1183dd2f7adb5ca07aaa3c8ebcf400b70',
    events: '039c80872f3e191006569aa2adcc47d81759552a46936006e5ba47d848b72aa70965184f5c021724171466b87399',
  },
  'turn-completes-while-a-send-waits': {
    whole: '6f808f1c4626a165699ef86ddf0c6ab6d7db2b724edd8086edf5d1db59cc0d27',
    events: '787880872f3eaa7b1e1b660dfb2bc07647d81759b5ff552a2bb04693deb247650ac69a7c16a947d828a69d3c845fd315d3de47d870ed223328a62557ef7a460847d8832a65ac469328a69d3cd71e072247d8d485552af16246939e5646939a7c51c6e4c547d8d71e5d7a47d828a6d71ebe3d47d8d71e47d8d71e47d8171466b882ad',
  },
  'work-checkpoints-and-verbs': {
    whole: 'de967ea481ee9f96c9a266553b97f631a14794afd395e1fee462c768374d45bd',
    events: '0cf6d6c9f0e847d81759552a497f891fad1247d89a8f6006b39b47d801acedc5e15ab1d69a2e87e357290367aba1086332c1fa6f59e52d01fa6fc84ede5ffa6ff1616fccfa6f5aa2e386ec97d2f0a9aaec976e8950c7ec9709aed19ab785160c47d81a2dffef315c5a3affef91ad449d9c15f8bacb1eb43ede0899b7d8494eb80db9b4caa779ab6e3a298eafa2526dfa7142129ff720aae51d61f7205884a7bcf7205c6d684ac156376447d8d27c8311022647d8e82b83110457a6e883116c1d8cf826a6377df48856bc40aa3e2cd584a9e765ac5333602bfd9b5333a396fd9b5333027f81f25333221aa851533316548c7317dc03d7cc4cfa6f1c6aec97fa09b78540d27c342aa7f7207e70e7ae164026a6f62f533300708e54213317142fad7399',
  },
  'admission': {
    whole: 'c4ad5a84adaa798e7e1ae54a08e09e2022f262fedc7d3ea9f8d63b9b0ad633dd',
    events: 'fd94f7db3d0a5442f7db3d0ae1898f2ef7dbf1e83d0adaff552ab8ed4693d57837c44693c1ebcee8f1e83d0a4c7bdfb07133552a1d9c4693deb2fedc58cb9a7c600695bd1759dfb0bc3e135efaf8b0d218ecef002c6c65704693ef00dfb0b3de34a74693ef00fc2973a15ec34693ef009d7560c04693ef00dfb0ed9ccc7e17142fad7399',
  },
  'notices-and-a-runner-restart': {
    whole: '0227f554861a95527168449389667accd70ffce5da3704e1980301314395fe07',
    events: '8c5680872f3e44d09d82290622186ecf336247d81759298fa13047d828a6ee98ea51355a47d828a66805399c6fa24671141547d844f4fcba47d88b56552af9444693deb26bae0ac69a7c73cd552a00aa469305a419709a7c98fd47d87b0d22639fc9d20ecace28a6ee987bf8f55146937c6d6ee32dfa47d828a64e950bbe4950904a47d8171466b882ad',
  },
  'leave': {
    whole: 'dc16fb57e8a8d7f40b8e2b26b8205cf7cdfe76a14258b53e632a6c876c846caa',
    events: '24a17fce52dcf0b67fce3bfaef3b7fce40dada447fcea482de287fce3d6ffd587fce7f3567577fcedf04758c7fceaee729467fceaf333f597fce1490789fd5c5ebcdd5c53bfaef3bd7ee17142fad7399',
  },
  'tail-and-text-rows': {
    whole: 'b3eb5acd407eaa17b386538ee4fbff64380a46d0091ec2ecbaa529c470a30ed7',
    events: '53cf80872f3e44d01ad249509bbdadf947d817596c080edbb743a088b4be2fdaeb84efe5f405bca00d8facfc2034f4895c6f189f737aaf0f664328a632c9de3d1768da6259d347d89a8f712cfa6c6ae95a2d8db0590e6ff8e804b298124727f7472cf512d2fdf29f5c477ed85460242ff131a857cc09da9827f7c67374f695e49851be488742646856afda98cd07d71e2e463e3b47d8e28e033be3b645fea130171432577399',
  },
  'display-rows': {
    whole: '484ecf010d478194a5f0655eac99bca321c4622b4453f1abdd78d589da23560b',
    events: '9982a22e1ab68f7180872f3e039bd8879eb650908f719ed03a318f71b6b717968f71320185afe58dc5818f71171466b87399',
  },
  'tool-progress': {
    whole: 'b1f3894d5892e950732f682b46edbd292a07f54cf8a2246c13461efa76784c53',
    events: '53962a1d0a3147d8552ae53159ba4b981fc4b2e5171466b817142fadff2d',
  },
  'busy-turn-with-no-facts': {
    whole: 'dcc19422e0e00f562d3fdf9c7a073076d09fb92736cf31ec22701fb8f53ffc5e',
    events: 'cf5d61551d3347d81759552a31ea13f0033f1325990e4480aac547d818cc1a4d4c96f4a91aa647d818cc4b279dae92ab36b947d817dc18cca9c88e54f8413c4947d86006b4fa47d818cc17142fad7399',
  },
  'feeds-while-attached': {
    whole: '7abf71156a7cf3d58803102f35e32e9650aeadb1bb39cbf58c679d4696263482',
    events: 'ce3d2a1d495c068621d59d131759552a7689a5e547d8a419b64339d7fc09109be2b387fef5db17144a1617142fadff2d',
  },
}

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
const sha = (text: string): string => createHash('sha256').update(text).digest('hex')
const mark = (event: string): string => sha(event).slice(0, 4)
const digestOf = (events: readonly string[]): { whole: string; events: string } => ({ whole: sha(events.join('\n')), events: events.map(mark).join('') })

const scratch = mkdtempSync(join(tmpdir(), 'connector-recording-proof-'))
function record(name: string): Recording {
  const out = join(scratch, `${name}.json`)
  const run = spawnSync(process.execPath, [SCENARIOS, '--emit', out], { cwd: ROOT, encoding: 'utf8', env: process.env, timeout: 240_000 })
  if (run.status !== 0) {
    console.log(run.stdout)
    console.log(run.stderr)
    throw new Error(`the scenarios did not run to their end (exit ${run.status}): the lines above name the step`)
  }
  return JSON.parse(readFileSync(out, 'utf8')) as Recording
}
function publicMethods(): string[] {
  const options = ts.parseJsonConfigFileContent(ts.readConfigFile(join(ROOT, 'tsconfig.json'), ts.sys.readFile).config, ts.sys, ROOT).options
  const program = ts.createProgram([CONNECTOR], { ...options, noEmit: true })
  const checker = program.getTypeChecker()
  const source = program.getSourceFile(CONNECTOR)
  const symbol = source === undefined ? undefined : checker.getExportsOfModule(checker.getSymbolAtLocation(source)!).find(s => s.name === 'DaemonSessionConnector')
  if (symbol === undefined) return []
  return checker
    .getPropertiesOfType(checker.getDeclaredTypeOfSymbol(symbol))
    .filter(member => {
      const declaration = member.valueDeclaration
      return declaration !== undefined && ts.isMethodDeclaration(declaration) && (ts.getCombinedModifierFlags(declaration) & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected)) === 0
    })
    .map(member => member.name)
    .sort()
}
function firstDifference(name: string, events: readonly string[], recorded: string): string {
  let at = 0
  while (at < events.length && mark(events[at]!) === recorded.slice(at * 4, at * 4 + 4)) at++
  let context = 'the opening of the scenario'
  for (let i = Math.min(at, events.length - 1); i >= 0; i--) {
    const event = JSON.parse(events[i]!) as { step?: string; call?: string }
    if (event.step !== undefined || event.call !== undefined) {
      context = event.step !== undefined ? `the step "${event.step.slice(0, 120)}"` : `the call of ${event.call}`
      break
    }
  }
  const was = recorded.length / 4
  if (at >= events.length) return `${name}: ${events.length} events where ${was} were recorded; the recording ends early, after ${context}`
  return `${name}: event ${at + 1} of ${events.length} (${was} recorded), in ${context}, is not the recorded one: ${events[at]!.slice(0, 600)}`
}

const first = record('first')
const names = Object.keys(first.scenarios)

if (process.argv.includes('--write')) {
  const dir = resolve(process.argv[process.argv.indexOf('--write') + 1]!)
  mkdirSync(dir, { recursive: true })
  for (const name of names) writeFileSync(join(dir, `${name}.jsonl`), first.scenarios[name]!.join('\n') + '\n')
  writeFileSync(join(dir, 'digests.json'), `${JSON.stringify(Object.fromEntries(names.map(name => [name, digestOf(first.scenarios[name]!)])), null, 1)}\n`)
  writeFileSync(join(dir, 'coverage.json'), `${JSON.stringify({ called: first.called, woken: first.woken }, null, 1)}\n`)
  console.log(`wrote ${names.length} recordings, digests.json and coverage.json to ${dir}`)
  rmSync(scratch, { recursive: true, force: true })
  process.exit(0)
}
if (process.argv.includes('--digests')) {
  console.log(`const RECORDED: Readonly<Record<string, { whole: string; events: string }>> = ${JSON.stringify(Object.fromEntries(names.map(name => [name, digestOf(first.scenarios[name]!)])), null, 2)}`)
  rmSync(scratch, { recursive: true, force: true })
  process.exit(0)
}

section('§1 the scenarios drive the connector the same way twice: every call, every wake and every answer in the same order')
{
  const second = record('second')
  const moved = names.filter(name => first.scenarios[name]!.join('\n') !== (second.scenarios[name] ?? []).join('\n'))
  check(`${names.length} scenarios recorded twice give ${names.length} equal recordings`, moved.length === 0 && Object.keys(second.scenarios).length === names.length, moved.map(name => firstDifference(name, second.scenarios[name] ?? [], digestOf(first.scenarios[name]!).events)).join(' · '))
}

section('§2 what the scenarios reach: every public method of the class and every kind of listener')
{
  const methods = publicMethods()
  const uncalled = methods.filter(name => !first.called.includes(name))
  check(`the class has public methods to call (${methods.length} read from the program's symbols)`, methods.length > 0)
  check(`every public method of DaemonSessionConnector is called by a scenario (${methods.length - uncalled.length} of ${methods.length})`, uncalled.length === 0, `add a call of ${uncalled.join(', ')} to a scenario in scripts/engine-connector/connectorScenarios.ts`)
  const asleep = LISTENER_KINDS.filter(kind => !first.woken.includes(kind))
  check(`every kind of listener is woken by a scenario (${LISTENER_KINDS.length - asleep.length} of ${LISTENER_KINDS.length})`, asleep.length === 0, `no scenario wakes ${asleep.join(', ')}`)
  const events = names.reduce((sum, name) => sum + first.scenarios[name]!.length, 0)
  console.log(`  ${names.length} scenarios · ${events} events`)
}

section('§3 the connector behaves as recorded, scenario by scenario')
if (process.platform === 'win32') {
  console.log('  the recordings are kept for hosts with POSIX paths; on this host §1 and §2 stand alone')
} else {
  const unrecorded = names.filter(name => RECORDED[name] === undefined)
  const gone = Object.keys(RECORDED).filter(name => !names.includes(name))
  check(`every scenario has a recording and every recording a scenario (${names.length} scenarios, ${Object.keys(RECORDED).length} recordings)`, unrecorded.length === 0 && gone.length === 0, `no recording: ${unrecorded.join(', ') || 'none'} · no scenario: ${gone.join(', ') || 'none'} — bun ${SELF} --digests prints the table RECORDED holds`)
  for (const name of names) {
    const recorded = RECORDED[name]
    if (recorded === undefined) continue
    const now = digestOf(first.scenarios[name]!)
    check(
      `${name}: ${first.scenarios[name]!.length} events, as recorded`,
      now.whole === recorded.whole,
      `${firstDifference(name, first.scenarios[name]!, recorded.events)} — to read the whole of it, write the recordings of the tree before the change and of this one (bun ${SELF} --write <folder>) and compare ${name}.jsonl; when the change of behaviour is meant, RECORDED in ${SELF} takes the table --digests prints`,
    )
  }
}

rmSync(scratch, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-connector-recording: the connector behaves as recorded' : `\nprove-connector-recording: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
