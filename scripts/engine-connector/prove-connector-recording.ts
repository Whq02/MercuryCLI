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
    whole: '4140ee62a92a8ef89c53b6b22b7e240b065e5080991eacee45695e8cdbb883e4',
    events: 'ad862a1d6ff2552ab7e16ed8229efe7717dc84e3d0c6a1552a7cf2156437e4511fc4b8ed2a1d1fc4c847ccc5171466b817142fadc847ccc517142fadc717',
  },
  'send-delivered': {
    whole: '3580f0a0ee8c8a5036a72ecfc1805bda7e41458c25d077316ba66243d38168ef',
    events: '93dc80872f3ed71efb2c1759552a132f552a47454693deb2b34146939a7c072231cecb5547d84513f15bf4c4f3d24205f6aadca9b78eb2014693015ff4c907223502d71edbd647d8673347d8171466b872b0',
  },
  'send-queued-then-recalled': {
    whole: 'fc5698e56d965d54ccfe945bd258f95871917df3358bc0cf96579927e2376d34',
    events: '4ca080872f3e694d995747d81759552a4005552a8da64693deb2d9280ac69a7c0988762a47d85ff03fccbd34469301045ff0517cddf9552a56cf469303ce0ac69a7c32ed47d874d152a6c39e74d1ceacd73217dc74d113ec8e5474d1c006bd344693e1a9db18552a07dd4693bccb0ac69a7cb417aa346f04203bb417203bd293552a8aa9469307110ac69a7cf72d3eb988ef46932844e7fa517c171466b846cd',
  },
  'send-refused-held-failed': {
    whole: '4385d27d167d4ecd8ce2b5cb81aa74eb61276540f12f9f0e42cbc2d30eeb912c',
    events: 'c08880872f3e6006fb2c1759552a289ad9054638d90504d2552a70f44693deb291b837c446939fd704d2552a70f44693e36546939a7c484a552ae7df4693edba70f44693c2f7d6b4552af1ca469312a6469383af17dc3e40552af3b44693deb2f1ca4693b3838e54e6ea552a73364693deb20c2c46939a7c579b552a61334693deb2796446939a7c25f8552a925c4693deb2e95646939a7c5c4c552a2c0d4693deb2dd514693bdea560d552a05bb4693deb243612c0d46934aeb8d92deb297e3d0033e64a89f2ff9a89f52bbdeb2e3287518c013deb26fe886b817dc6d28deb2c29f8e5417142d705b6a',
  },
  'asks-answered-and-settled': {
    whole: 'fefbd67420ccf25b6cdb3f9004a98b17b029d94903b0dc2976301dff20033f53',
    events: '5d0780872f3e560a41dde88289d6835147d81759b9ad08c315dab9ad042abfbb9a7bb6973ca9e2eba51dc169b6f5b697b13d64f7f3e3c1696597b697552a51124693deb2bd0b0ac6e06a6e3377a6bf39818477a68184c8fac8f7e5ed6fac5f198dd8c0bac169cdbece622e9617dc4100c16909188e549dd1a9b16006d5eda33647d8cc59c169af4571d5a847e3d5a13a171466b872b0',
  },
  'interrupt-mid-turn': {
    whole: 'ce17853835a9de2ff98198fdcf4ec3c8dd6ccf25849d5a67b173366ddabab41b',
    events: '25fb80872f3ecc59696d44d063fc58159397109147d81759d884d67bc3fdd154cc593ae98448d718469371d5db2ebaeb095acc593ae946d971d5b0b6cc593ae971d59c2ce4b8600687e247d8957d9c2c87948b0fa4d81bace9b047d85195e81e07c63df6cc593ae98934d718469371d50861f49f751f55d9806417dccc593ae9d820d718469371d5f49f8e547b872582cc593ae9623371d55aae2c7ae6ff46936006d99647d8171466b87399',
  },
  'rewind': {
    whole: 'ced1fe81068fc9ce0fb65c7c2e6c16441d4666160393ee7b9596f5a0c55a7304',
    events: 'de2b80872f3e9903014863547cc447d81759b2979aee8f71fb88dfac3499f7db01fd7b8c8a7d4932a09e1bcb47dd6bac7880405b2a87865ad5568c714f0dd55685ebec0bd556e3a77521d55660c15d4fd55613e20ca917dcd556fbe38e546006b39b47d8171466b87399',
  },
  'fold-and-its-exit': {
    whole: 'd5f7b89acb8d5f9c6cb85c6e674d9f195896f9fa39cd8e3e8535cac1bc949547',
    events: 'cdf880872f3e43721eb647d81759552aba4a1754dbfa84fd552adbb24693deb2021cd02646939a7c28e2051347d8f0afb9c928a64a7770527ed86c54aa5b46934693469346934693033f8781c38cb92da8aaab2b6d5cc38c7ed8b92df254469346934693469346938781ecb0ab2b5c5e06a8b92daa3547d8f25487818b2aba3e7a6747d8b3ab749bcd95d71e8781531047d8becf58c747668781e28eb92d171466b872b0',
  },
  'model-and-effort': {
    whole: 'fc8497da01445a9b9a95e7ae3b36292f1272023b36f5b5f9d3c2d500029e6d46',
    events: 'fa95dde5d93133df6006fb2c1759552abc6144834d1333dfdde5b622047d47d8b198b98dc7464483a04c4f340b1347d8dde5774f001413e1ac092fbb47d83fc31f57237b47d80831e121b05a4483ec160831e12156bb4483a1140831e12190f9448313e10831e12165484483b622047d47d80831e121a9cb44830b8717dc0831e1214483b0808e54e222437afac8ed88e2222ffd173f9dc647d87f7c7c57b8e4297550a0469347d8ed882975f240469347d80c0829756593469347d8e3e02975315c469347d82ffd29756385469347d876b617dc2975469347d835658e5479279ffb17142fad7399',
  },
  'permission-mode': {
    whole: '7e6fa4e4408ffddd04898ed4fc776874bc3324d44720e6254f14c437b49c9942',
    events: '1bceb79864b598e66006fb2c1759552ab798939cd824090bbcf347d8b79817593e24c9d725a77746de8b939c47d8b523bfb6d6f583c0939c47d876e117dcbfb6d6f5939c47d85ac08e547996d6f547d8792717142fad7399',
  },
  'carrier-gone-and-back': {
    whole: '39da076ab49477aae33c20fc08990555b133041d99cff5ef01c7d0229bd67200',
    events: '1ce580872f3e6df490b2d0a2d29b012b47d81759db574497606f44977aed4497e448449710bc51b4b2efd89c4497673347d8f4a386e447d8768944974ca74497059744978d7551b4af899e0d2133171466b87399',
  },
  'transcript-unreadable': {
    whole: '195a60027f678e43c375fcb0bcf4d59e4bbd275a487ea79c763958a91ba92529',
    events: '039c80872f3e191006568a8b50db47d81759552a469360066f8d47d848b72aa7c6d6184f5c021724171466b87399',
  },
  'turn-completes-while-a-send-waits': {
    whole: '6779d6c9383a8d3d1a13e5e5e0e6a01774edbef46834b31a6a174c9f94ec8dad',
    events: '787880872f3eaa7bcf8b4e001caab62e47d81759b5ff552a72cf4693deb240560ac69a7c16a947d828a69d3c845fd315046247d8e52dcaaa28a6d7321de2428b47d8832a196d469328a69d3cd71e624647d8d485552ab91c4693b6fc46939a7c51c6983f47d8d71eff0a47d828a6d71e300347d8d71e47d8d71e47d8171466b882ad',
  },
  'work-checkpoints-and-verbs': {
    whole: 'de967ea481ee9f96c9a266553b97f631a14794afd395e1fee462c768374d45bd',
    events: '0cf6d6c9f0e847d81759552a497f891fad1247d89a8f6006b39b47d801acedc5e15ab1d69a2e87e357290367aba1086332c1fa6f59e52d01fa6fc84ede5ffa6ff1616fccfa6f5aa2e386ec97d2f0a9aaec976e8950c7ec9709aed19ab785160c47d81a2dffef315c5a3affef91ad449d9c15f8bacb1eb43ede0899b7d8494eb80db9b4caa779ab6e3a298eafa2526dfa7142129ff720aae51d61f7205884a7bcf7205c6d684ac156376447d8d27c8311022647d8e82b83110457a6e883116c1d8cf826a6377df48856bc40aa3e2cd584a9e765ac5333602bfd9b5333a396fd9b5333027f81f25333221aa851533316548c7317dc03d7cc4cfa6f1c6aec97fa09b78540d27c342aa7f7207e70e7ae164026a6f62f533300708e54213317142fad7399',
  },
  'admission': {
    whole: '2df27b3039630fa422c31e551232b1ce51b10574578bfabfded7fa31e4818918',
    events: '55ddf7db3d0a5442f7db3d0ae1898f2ef7dbe89f3d0adaff552a66864693d57837c44693c1ebcee8e89f3d0a4c7bdfb07133552acf734693deb227b2faae9a7c600695bd1759dfb0c068d6d5447a7f3d18ecef002c6c907a4693ef00dfb0b3de0c824693ef00fc2973a1cde34693ef009d75cfa64693ef00dfb055f9a12e17142fad7399',
  },
  'notices-and-a-runner-restart': {
    whole: '1e88449d208081e76637dc5758c43f81472e59922c289fdeae79d7bb95809d4e',
    events: '8c5680872f3e44d02a7be8b806e180db538847d81759298f4b4e47d828a6ee98ea51278747d828a66805399cdc9b9924141547d844f444b847d88b56552a3d664693deb24e460ac69a7c73cd552a85ad4693f40619709a7c98fd47d8d90270e2cfae9fc99f03c1b2bce828a6ee987bf8f649469315ce0bc027ea47d828a64e951510bda1904a47d8171466b882ad',
  },
  'leave': {
    whole: 'dc16fb57e8a8d7f40b8e2b26b8205cf7cdfe76a14258b53e632a6c876c846caa',
    events: '24a17fce52dcf0b67fce3bfaef3b7fce40dada447fcea482de287fce3d6ffd587fce7f3567577fcedf04758c7fceaee729467fceaf333f597fce1490789fd5c5ebcdd5c53bfaef3bd7ee17142fad7399',
  },
  'tail-and-text-rows': {
    whole: '94a253097891064772900ce39797fecb02beb1fce71208aeea346dd376f66477',
    events: '53cf80872f3e44d0fc44c20d9466b64047d817596c086cef0a5a01c1b4be87e83d26a3c89c13731ce92bacfc203493edbc11523e189f405afab2664328a613ea32c9557bfd19dc81da62024947d89a8f712c3cd3e9c95a2d8db0590e6ff8b575eed412476191472c91c3d2fda51281177ed85460d88a242fdcfa414dfe7bcc09da9861916c0c6b1c027695e4985134ea583cd486c787646856afda98ece0cd07d71e3409180147d8e28e033be3b6aee67aeb171432577399',
  },
  'display-rows': {
    whole: '11fcd27b4e3bbe4ff32e52a55341aeb6aef26a4c670cd5071826e372db1e2659',
    events: '99822dcbfa758f7180872f3e039bf3f3302193fa8f712c6f47d68f71910545628f713201b0a663de99148f71171466b87399',
  },
  'tool-progress': {
    whole: '280658699f867ce8cb72649987dc2880f9c0d6a43d3aacd4b45e5433232708bb',
    events: '53962a1d4c7c47d8552afe5c995f520909c047454b385b9fe13d1fc4b2e51714229efe7717dc84e3d0c6a1552a7cf215643766b817142fadff2d',
  },
  'busy-turn-with-no-facts': {
    whole: '37464b5493d9fb5710076160a2c101af27050655a3e05ddd6c09ebf56157a993',
    events: 'cf5da0e27ed247d81759552a31ea13f0033f1325990e5efa385247d818cc1a4d7411b83eee7847d818cc4b2727a1a937495647d817dc18cceac88e54d2660c4d47d86006a78147d818cc17142fad7399',
  },
  'feeds-while-attached': {
    whole: 'a218b768a1bffd93a2e9a12b0e79523fdbb7ed6de2fdf230c4d663cad2da7318',
    events: 'ce3d2a1d495c068621d59d131759552a7689a5e547d8a419254439d72713fc09109b63ede2b3939c993787fe229efe7717dc84e3d0c6a1552a7cf2156437f5db171442244a1617142fadff2d',
  },
  'a-watchdog-the-facts-spell-as-text': {
    whole: '6d3ea1bdbfcfe5d7b05a88e2e7e3fff60996f1ce07d48b74920effb0c0cab29c',
    events: 'a887db0a4a8347d81759552abee524bb9d644b7e67d2ecc76fc917321c2267d28c8a6fc91732086e60063942ff32eeb247d817142fad7399',
  },
  'the-setting-chosen-again-while-another-model-serves': {
    whole: '1cc7ad74656d02843e7daf3d9192a2c2741acbfec7cccae228ed343c4e72ca04',
    events: '739ff73441e51759552adde544833d0f9403b622d939e0a147d8dde553f73d0f597347d8b622f73471db47d817142fad7399',
  },
  'quiet-carrier-mid-send': {
    whole: 'a93792c54b96236f4b5d1c944db09a7e5c7463d94390bdcd2af52e4a5d54f45c',
    events: '10c680872f3ed71efb2c1759552ac7b8552aa3914693deb233cc6902c4c347d87a2db654413bda24cc593ae937059c85469371d5084f6b30adacdd15814cca9201ec46937ac5656fd71e6f0247d841f0552af4d24693a609e62dd81247d8b4be2011d71e331147d8748d648e4693b4b0f29d92dd552a4693deb2d6c846939a7cd71ef40e171466b80e07',
  },
  'two-answers-to-one-ask': {
    whole: '6e14bc11050b1cdf5471dcf72b59329c1fe1bc13c13ec248b0513f5554c634d4',
    events: '1d1580872f3e1dae033dbb98e728244c47d817598b3d0f545fc08d17552a34814693deb20ac6ad5fdf6bf5b4fd65c1694dc50b3a15da0f54ec298d171912ca53c169818419ede2eba13a6006da67116c47d8171466b872b0',
  },
  'transcript-shrinks-mid-turn': {
    whole: 'a149817f1c067a25ce6b9e802ec6ae197d06e1e86a123b54868b7f0686a0f54f',
    events: 'aa7d80872f3e11692afc2020fe4d47d81759885194378f71c7aebe233104de427b2b7f985cac3ccf9180552a79774693deb242b10ac69a7c257136ac47d89ab742fe71723fb23d4544c71b8b8f71a22de0611b0c02e32c73528e36ac56f9d2e9d71e63a7cbca47d8171466b872b0',
  },
  'daemon-dies-and-restarts': {
    whole: 'a2cfd908ff02d65b68b6a24ea262548e7f9146426f6f27207a1b9ade2b8858fa',
    events: 'ad6d80872f3e44d028e26a9b6247ebb547d81759a251a5ad552af7d54693deb26a4d0ac69a7ce61247d87689a61896511fddfded449749814497a9854497b3534497f6c951b4139ad47a0fc779f74497c61347d82b474a1646937a3f47d89a8f3a6fde7d47d8449745bb35aaa6d569c970ca0e1ebc704693a34fdcf959b45e7747d8171466b872b0',
  },
  'listeners-that-call-back': {
    whole: '5d1dd22def36689cd511f8410e7a008bcbd8439eb0dcb4d50f6d52cf8244f5be',
    events: 'd0e980872f3ed387f56343af1c242c1247d8175946b7459a5bf37f14157dc1696b6e857c4693e07630b215dab41e63203a539342fb2f65d501818c87c4198b2aef86b5b17ed847d8c169bbab857c4693e076919e8d00ab2bdbfaed2238c7d71e39872e2547d8171466b87399',
  },
  'send-demoted-then-delivered': {
    whole: 'fb9c1b5069642854c76af998fd337945e5c332acb926c76e229672e5345295fa',
    events: '0c1980872f3ed71efb2c1759552aca24552a37544693deb2c3a446939a7c07229356dfdd47d8673347d807225adbe0b15fd947d80e3d552aaf4b0cb72e1f6285d525b1e66d4d4693e21f5b540722d15dd71e5c5a47d8171466b872b0',
  },
  'an-echo-retired': {
    whole: '18ac32d368c992f910c4bd5a8a34aa46f9a8a1e984b01cee13b6a7e386ce6daf',
    events: '3e4280872f3e44d03a65c227de3cca3447d8175953d2552a122e4693deb2e1800ac69a7cf611552ab72e4693d5ed19709a7ca9de47d87e1a9bb647d80640809e47d810c2d60295483f17ac2547d8171466b882ad',
  },
  'transcript-grows-while-it-is-read': {
    whole: 'ce76edba8205396713d63ab0a1e11f4ff2957666c01c7d71766e6e48458e51c4',
    events: '216a80872f3e44d0740a6c2747bc2c9247d817599cbb7639469346933d6278b946934693600633a647d8171466b87399',
  },
  'watcher-fires-twice': {
    whole: '16df86235f4240ce562547645f326e1886392ee628bcf83bb2e60350f130e9c6',
    events: 'f96b80872f3e36b8cc124c758a55cbc247d817592fed9aedeae9d54de2acbfdf7fc546932ba47c44aa3c6006f27647d8171466b87399',
  },
  'the-two-turn-starts-differ': {
    whole: '881cd229cba488ec84930297e77fff2099789762cb18b5dc5859d14a7eb3b68b',
    events: '0c8180872f3e44d0f4f11557dfb0482fedd747d817598b09469347d88a42469347d888df305846936006decf47d8171466b87399',
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
