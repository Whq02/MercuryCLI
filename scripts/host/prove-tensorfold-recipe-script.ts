import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { bashSyntax } from './bashSyntax.mjs'

if (!process.env.MERCURY_CONFIG_DIR) throw new Error('A scratch MERCURY_CONFIG_DIR is required')
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
const { HOST_RECIPES } = await import('../../src/services/host/recipes.ts')
const { TENSORFOLD_CARDS, TENSORFOLD_HOST_IMAGE, TENSORFOLD_HOST_VERSION, TENSORFOLD_RELEASE_ARCHIVES, TENSORFOLD_RELEASE_PUBLIC_KEY, TENSORFOLD_RELEASE_SIGNED_PREFIX, TENSORFOLD_STARTING_POINTS, tensorFoldEngineScript, tensorFoldHostRecipes, tensorFoldKeyWriteCommand, tensorFoldMemoryGib, tensorFoldReadyCommand, tensorFoldWindowFor } = await import('../../src/services/host/tensorfoldRelease.ts')
const { hostSetupEstimate } = await import('../../src/commands/llmhost/words.ts')

let checks = 0
const check = (name: string, truth: unknown): void => { assert.ok(truth, name); checks++; console.log('PASS ' + name) }
const scratch = mkdtempSync(join(process.env.MERCURY_CONFIG_DIR, 'tensorfold-script-'))
const pem = (key: string): string => '-----BEGIN PUBLIC KEY-----\n' + key + '\n-----END PUBLIC KEY-----\n'
const fixtures = join(import.meta.dir, 'fixtures')
const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64'
const platform = TENSORFOLD_RELEASE_ARCHIVES[arch].platform
const archiveName = 'tensorfold-' + TENSORFOLD_HOST_VERSION + '-' + platform + '.tar.gz'

try {
  const rows = tensorFoldHostRecipes()
  const recipe = HOST_RECIPES.find(row => row.id === 'tensorfold-qwen38-27b-rtx-5090')!
  check('the TensorFold recipes sit in HOST_RECIPES beside SGLang and vLLM (' + rows.length + ' rows, three starting points)', rows.length === 24 && rows.every(row => HOST_RECIPES.some(own => own.id === row.id)) && new Set(rows.map(row => row.model)).size === 3)
  check('every row pins the CUDA 13.0.3 base image by digest on CUDA 13.0 with TensorFold ' + TENSORFOLD_HOST_VERSION, rows.every(row => row.image === TENSORFOLD_HOST_IMAGE && /@sha256:[a-f0-9]{64}$/.test(row.image) && row.cuda === '13.0' && row.engine === 'tensorfold'))
  check('pod classes: sm_120/121 and sm_80/86 are supported, sm_89 ships unqualified, sm_90+ has no recipe', ['RTX 5090', 'RTX PRO 6000', 'GB10', 'A100', 'RTX A6000', 'RTX 3090'].every(gpu => rows.some(row => row.gpu === gpu && row.verified.by === 'documented')) && ['RTX 4090', 'L40S', 'L4'].every(gpu => rows.filter(row => row.gpu === gpu).every(row => row.verified.by === 'unverified' && row.verification.startsWith('ships · unqualified by TensorFold'))) && ['H100', 'H200', 'B200', 'B300', 'GB300'].every(gpu => !rows.some(row => row.gpu === gpu) && TENSORFOLD_CARDS.find(card => card.gpu === gpu)?.class === 'refused'))
  check('refused classes name the reason: SASS-only machine code, no PTX', TENSORFOLD_CARDS.filter(card => card.class === 'refused').every(card => /no sm_\d+ machine code and no PTX/.test(card.evidence)))
  const point27 = TENSORFOLD_STARTING_POINTS.find(point => point.name === 'qwen3.8-27b')!
  check('windows come from the card memory: the 27B lands at 128k on a 32 GB RTX 5090 (~28.6 GiB), 256k on 48 GB and above, and is not offered on the 24 GB cards (its 32k fit is a row that refuses in use — the lead\'s fold row; the floor is 64k); Lightning and the 2B at 256k everywhere', recipe.context === 131072 && Math.abs(tensorFoldMemoryGib(point27, 131072) - 28.56) < 0.1 && tensorFoldWindowFor(point27, { vramGb: 48 }) === 262144 && tensorFoldWindowFor(point27, { vramGb: 24 }) === undefined && !rows.some(row => row.model === point27.repo && row.vramGb === 24) && rows.filter(row => row.model !== point27.repo).every(row => row.context === 262144))
  check('every verification line is an estimate with the window, the memory and the evidence', rows.every(row => row.verification.includes('(an estimate)') && row.verification.includes(' window') && row.verification.includes(' GiB of ')))
  check('the serve flags carry the pinned short name, the window, the 27B drafter and the 2B prompt cache; the host, port and key file ride the script, not the recipe', recipe.flags.join(' ') === '--name qwen3.8-27b --context 131072 --drafter z-lab/Qwen3.8-27B-DFlash2' && rows.find(row => row.id === 'tensorfold-qwen35-2b-rtx-5090')!.flags.join(' ') === '--name qwen3.5-2b --context 262144 --prompt-cache-gib 1' && rows.every(row => !row.flags.includes('--host') && !row.flags.includes('--port') && !row.flags.includes('--api-key-file') && !row.flags.includes('--enable-cache-report')))
  check('the effort ladder is Mercury’s five levels (none rides ⌥T off on the wire)', rows.every(row => row.efforts?.levels.join(' ') === 'low medium high xhigh max'))
  check('the setup estimate says engine ~1 min for the 46 MB archive', hostSetupEstimate(recipe).startsWith('engine ~1 min · downloads 19.93 GB'))

  const dir = '/workspace/mercury-host/' + recipe.id
  const script = tensorFoldEngineScript(recipe, dir)
  const lines = script.split('\n')
  const at = (needle: string): number => { const index = lines.findIndex(line => line.includes(needle)); assert.ok(index >= 0, 'script line: ' + needle); return index }
  check('bash -n accepts the script', bashSyntax(script).status === 0)
  check('HF_HOME sits on the pod volume (/workspace) and HOME persists the window-cost cache there', lines.includes('export HF_HOME="$volume/huggingface"') && lines.includes("volume='/workspace'") && lines.includes('export HOME="$volume/mercury-host/home"'))
  check('the R580 driver check and the compute-capability gate run before anything is downloaded or pulled', at('driver_version') < at('compute_cap') && at('compute_cap') < at('MERCURY_STEP downloading') && at('MERCURY_STEP downloading') < at('MERCURY_STEP pulling') && lines.some(line => line.includes('-lt 580')) && lines.some(line => line.includes('case "$capability" in 8.0|8.6|8.9|12.0|12.1)')))
  check('the archive name follows the pod’s CPU: linux-x86_64 or linux-aarch64, with the measured digest pinned per arch', lines.some(line => line.includes('x86_64) platform=linux-x86_64; expected=' + TENSORFOLD_RELEASE_ARCHIVES.x86_64.sha256)) && lines.some(line => line.includes('aarch64|arm64) platform=linux-aarch64; expected=' + TENSORFOLD_RELEASE_ARCHIVES.aarch64.sha256)) && lines.includes('archive="tensorfold-' + TENSORFOLD_HOST_VERSION + '-$platform.tar.gz"'))
  check('the three downloads are install.sh’s curl lines: the archive, the .sha256 sidecar (≤1024 B) and the .sha256.sig (≤64 B), https only, and a missing signature stops the install', lines.some(line => line.trim() === 'curl --proto \'=https\' --proto-redir \'=https\' -fsSL --retry 3 "$base" -o "$archive"') && lines.some(line => line.trim() === 'curl --proto \'=https\' --proto-redir \'=https\' -fsSL --retry 3 --max-filesize 1024 "$base.sha256" -o "$archive.sha256"') && lines.some(line => line.trim().startsWith('curl --proto \'=https\' --proto-redir \'=https\' -fsSL --retry 3 --max-filesize 64 "$base.sha256.sig" -o "$archive.sha256.sig" || { echo \'This release has no checksum signature, so this installer stops.\'')))
  check('the signature check is install.sh’s construction: the embedded Ed25519 key, the signed prefix and openssl pkeyutl -verify -rawin', lines.some(line => line.includes("'-----BEGIN PUBLIC KEY-----' '" + TENSORFOLD_RELEASE_PUBLIC_KEY + "' '-----END PUBLIC KEY-----' > release-key.pem")) && lines.some(line => line.trim() === "{ printf 'tensorfold-native-checksum-v1\\n'; cat \"$archive.sha256\"; } > signed-checksum") && lines.some(line => line.trim().startsWith('openssl pkeyutl -verify -rawin -pubin -inkey release-key.pem -in signed-checksum -sigfile "$archive.sha256.sig" >/dev/null 2>&1 || { echo \'Release signature verification failed; a signed checksum and OpenSSL with Ed25519 support are required.\'')) && TENSORFOLD_RELEASE_SIGNED_PREFIX === 'tensorfold-native-checksum-v1\n')
  check('the signed sidecar must name the measured digest and archive, then sha256sum -c runs, then tar -xzf with the tree kept whole (no --strip-components)', at('openssl pkeyutl') < at('"$expected  $archive"') && at('"$expected  $archive"') < at('sha256sum -c "$archive.sha256"') && at('sha256sum -c') < at('tar -xzf "$archive"') && !script.includes('--strip-components') && lines.some(line => line.includes('bin/tensorfold-native" ] && [ -r "tensorfold-' + TENSORFOLD_HOST_VERSION + '-$platform/lib/libtfgrammar.so" ]')))
  check('the pull is mandatory and comes before the serve: the checkpoint, then the drafter, then the engine starts', at("MERCURY_STEP pulling TensorFold/Qwen3.8-27B-MLX-4bit") < at("tensorfold-native pull 'TensorFold/Qwen3.8-27B-MLX-4bit'") && at("tensorfold-native pull 'TensorFold/Qwen3.8-27B-MLX-4bit'") < at("tensorfold-native pull 'z-lab/Qwen3.8-27B-DFlash2'") && at("tensorfold-native pull 'z-lab/Qwen3.8-27B-DFlash2'") < at('MERCURY_STEP starting engine') && at('MERCURY_STEP starting engine') < at("'tensorfold-native' 'serve'"))
  check('the serve binds 0.0.0.0:8080 with the key file, the short name, the window and the drafter', lines.some(line => line === "'tensorfold-native' 'serve' 'TensorFold/Qwen3.8-27B-MLX-4bit' '--name' 'qwen3.8-27b' '--context' '131072' '--drafter' 'z-lab/Qwen3.8-27B-DFlash2' '--host' '0.0.0.0' '--port' '8080' '--api-key-file' \"$dir/api-key\"") && lines.at(-2) === 'wait')
  check('the 2B pulls its pinned revision and serves the bare repo with its 1 GiB prompt cache', (() => { const two = tensorFoldEngineScript(HOST_RECIPES.find(row => row.id === 'tensorfold-qwen35-2b-rtx-5090')!, '/workspace/mercury-host/x'); return two.includes("tensorfold-native pull 'mlx-community/Qwen3.5-2B-MLX-4bit@93760be4f1f69842a46bc13dbdc0f19e291392a3'") && two.includes("'serve' 'mlx-community/Qwen3.5-2B-MLX-4bit' '--name' 'qwen3.5-2b' '--context' '262144' '--prompt-cache-gib' '1' '--host' '0.0.0.0' '--port' '8080'") })())
  const ready = tensorFoldReadyCommand(dir)
  check('readiness is the pair: /health key-blind for liveness, then GET /v1/models with the key from the key file', ready === 'curl -fsS --max-time 10 http://127.0.0.1:8080/health >/dev/null && curl -fsS --max-time 10 -H "Authorization: Bearer $(cut -d \' \' -f 2 \'' + dir + '/api-key\')" http://127.0.0.1:8080/v1/models' && bashSyntax(ready).status === 0)

  for (const name of [arch, arch === 'x86_64' ? 'aarch64' : 'x86_64'] as const) {
    const sidecar = readFileSync(join(fixtures, 'tensorfold-' + TENSORFOLD_HOST_VERSION + '-linux-' + name + '.tar.gz.sha256'))
    const signature = readFileSync(join(fixtures, 'tensorfold-' + TENSORFOLD_HOST_VERSION + '-linux-' + name + '.tar.gz.sha256.sig'))
    const digest = sidecar.toString('utf8').split(' ')[0]
    check('the pinned ' + name + ' digest equals his published sidecar, whose signature verifies under the embedded key (Node Ed25519)', digest === TENSORFOLD_RELEASE_ARCHIVES[name].sha256 && signature.length === 64 && verify(null, Buffer.concat([Buffer.from(TENSORFOLD_RELEASE_SIGNED_PREFIX), sidecar]), createPublicKey(pem(TENSORFOLD_RELEASE_PUBLIC_KEY)), signature))
  }

  const sandbox = join(scratch, 'pod'); mkdirSync(join(sandbox, 'bin'), { recursive: true })
  const keyPair = generateKeyPairSync('ed25519')
  const fixturePublicKey = keyPair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
  const release = join(scratch, 'release'); mkdirSync(release)
  const tree = join(scratch, 'tree', 'tensorfold-' + TENSORFOLD_HOST_VERSION + '-' + platform); mkdirSync(join(tree, 'bin'), { recursive: true }); mkdirSync(join(tree, 'lib'))
  const calls = join(sandbox, 'calls.jsonl')
  writeFileSync(join(tree, 'bin', 'tensorfold-native'), '#!/bin/bash\nprintf \'%s\\n\' "$(printf \'%s\\t\' "$@")" >> ' + JSON.stringify(calls) + '\ncase "$1" in --version) echo "tensorfold-native ' + TENSORFOLD_HOST_VERSION + '";; pull) echo "pulled $2 into $HF_HOME";; serve) echo "serving $2 (HOME=$HOME)"; test "$(stat -f %Lp "${@: -1}" 2>/dev/null || stat -c %a "${@: -1}")" = 600 || { echo "key file is not 0600"; exit 9; };; esac\n', { mode: 0o755 })
  writeFileSync(join(tree, 'lib', 'libtfgrammar.so'), 'fixture grammar library\n')
  for (const file of ['LICENSE', 'VERSION', 'SHA256SUMS']) writeFileSync(join(tree, file), file + '\n')
  const tar = spawnSync('tar', ['-czf', join(release, archiveName), '-C', join(scratch, 'tree'), 'tensorfold-' + TENSORFOLD_HOST_VERSION + '-' + platform], { encoding: 'utf8' })
  assert.equal(tar.status, 0, tar.stderr)
  const archiveDigest = createHash('sha256').update(readFileSync(join(release, archiveName))).digest('hex')
  const sidecarText = archiveDigest + '  ' + archiveName + '\n'
  writeFileSync(join(release, archiveName + '.sha256'), sidecarText)
  writeFileSync(join(release, archiveName + '.sha256.sig'), sign(null, Buffer.from(TENSORFOLD_RELEASE_SIGNED_PREFIX + sidecarText), keyPair.privateKey))
  writeFileSync(join(sandbox, 'bin', 'curl'), '#!/bin/bash\nout=""; url=""\nwhile [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift 2;; --max-filesize|--retry) shift 2;; -*) shift;; *) url="$1"; shift;; esac; done\necho "$url" >> ' + JSON.stringify(join(sandbox, 'curl.log')) + '\ncase "$url" in https://*) ;; *) echo "curl: only https" >&2; exit 2;; esac\nsource=' + JSON.stringify(release) + '/"$(basename "$url")"\ntest -f "$source" || exit 22\ncp "$source" "$out"\n', { mode: 0o755 })
  writeFileSync(join(sandbox, 'bin', 'nvidia-smi'), '#!/bin/bash\ncase "$*" in *driver_version*) echo "${FIXTURE_DRIVER:-580.95.05}";; *compute_cap*) echo "${FIXTURE_CAPABILITY:-12.0}";; esac\n', { mode: 0o755 })
  const volume = join(sandbox, 'workspace'); mkdirSync(volume)
  const podDir = join(volume, 'mercury-host', recipe.id); mkdirSync(podDir, { recursive: true })
  const podScript = tensorFoldEngineScript(recipe, podDir, { volume, publicKey: fixturePublicKey, releaseBase: 'https://releases.fixture.invalid/v' + TENSORFOLD_HOST_VERSION + '/', archives: { x86_64: { sha256: archiveDigest }, aarch64: { sha256: archiveDigest } } })
  writeFileSync(join(sandbox, 'engine.sh'), podScript)
  const keyWrite = spawnSync('bash', ['-c', tensorFoldKeyWriteCommand(podDir, 'fixture-key-not-a-real-key')], { encoding: 'utf8' })
  assert.equal(keyWrite.status, 0, keyWrite.stderr)
  check('the key file Mercury writes is mercury[inference]: KEY at mode 0600', readFileSync(join(podDir, 'api-key'), 'utf8') === 'mercury[inference]: fixture-key-not-a-real-key\n' && (statSync(join(podDir, 'api-key')).mode & 0o777) === 0o600)
  const run = (env: Record<string, string> = {}): { status: number | null; log: string } => {
    const result = spawnSync('bash', [join(sandbox, 'engine.sh')], { encoding: 'utf8', env: { ...process.env, ...env, PATH: join(sandbox, 'bin') + ':' + process.env.PATH, HOME: join(sandbox, 'home-before') }, timeout: 60_000 })
    return { status: result.status, log: result.stdout + result.stderr }
  }
  const refusedDriver = run({ FIXTURE_DRIVER: '550.54.15' })
  check('an R550 driver is refused before any download: the log names R580 and nothing was fetched', refusedDriver.status === 1 && refusedDriver.log.includes('NVIDIA driver 550.54.15 is older than R580 (CUDA 13.0), which TensorFold 1.2.2 needs') && !existsSync(join(sandbox, 'curl.log')))
  const refusedCapability = run({ FIXTURE_CAPABILITY: '9.0' })
  check('an sm_90 card is refused before any download with the SASS-only reason', refusedCapability.status === 1 && refusedCapability.log.includes('ships no CUDA kernels for compute capability 9.0') && refusedCapability.log.includes('no PTX') && !existsSync(join(sandbox, 'curl.log')))
  const goodSignature = readFileSync(join(release, archiveName + '.sha256.sig'))
  writeFileSync(join(release, archiveName + '.sha256.sig'), Buffer.from(goodSignature.map((byte, index) => index === 7 ? byte ^ 0xff : byte)))
  const tampered = run()
  check('a tampered signature stops the install before extraction (real openssl pkeyutl -rawin)', tampered.status === 1 && tampered.log.includes('Release signature verification failed') && !existsSync(join(podDir, 'tensorfold-' + TENSORFOLD_HOST_VERSION + '-' + platform)) && !tampered.log.includes('MERCURY_STEP pulling'))
  writeFileSync(join(release, archiveName + '.sha256.sig'), goodSignature)
  const unexpected = tensorFoldEngineScript(recipe, podDir, { volume, publicKey: fixturePublicKey, releaseBase: 'https://releases.fixture.invalid/v' + TENSORFOLD_HOST_VERSION + '/', archives: { x86_64: { sha256: '0'.repeat(64) }, aarch64: { sha256: '0'.repeat(64) } } })
  writeFileSync(join(sandbox, 'engine.sh'), unexpected)
  const drifted = run()
  check('a validly signed sidecar whose digest is not the measured one is refused', drifted.status === 1 && drifted.log.includes('names another archive or digest than the one Mercury measured') && !existsSync(join(podDir, 'tensorfold-' + TENSORFOLD_HOST_VERSION + '-' + platform)))
  writeFileSync(join(sandbox, 'engine.sh'), podScript)
  rmSync(join(sandbox, 'curl.log'), { force: true })
  const happy = run()
  const log = happy.log
  const order = ['MERCURY_STEP checking the NVIDIA driver', 'MERCURY_STEP driver 580.95.05 · compute capability 12.0', 'MERCURY_STEP downloading TensorFold ' + TENSORFOLD_HOST_VERSION + ' for ' + platform, archiveName + ': OK', 'MERCURY_STEP TensorFold ' + TENSORFOLD_HOST_VERSION + ' installed', 'MERCURY_STEP pulling TensorFold/Qwen3.8-27B-MLX-4bit', 'pulled TensorFold/Qwen3.8-27B-MLX-4bit into ' + volume + '/huggingface', 'MERCURY_STEP pulling z-lab/Qwen3.8-27B-DFlash2', 'MERCURY_STEP starting engine', 'serving TensorFold/Qwen3.8-27B-MLX-4bit (HOME=' + volume + '/mercury-host/home)'].map(needle => log.indexOf(needle))
  check('the happy path runs in order: driver → download → verify → install → pull → pull the drafter → serve (exit 0)', happy.status === 0 && order.every((index, n) => index >= 0 && (n === 0 || index > order[n - 1]!)))
  check('the three fetches are the archive, the sidecar and the signature over https', readFileSync(join(sandbox, 'curl.log'), 'utf8').trim().split('\n').join(' ') === ['', '.sha256', '.sha256.sig'].map(suffix => 'https://releases.fixture.invalid/v' + TENSORFOLD_HOST_VERSION + '/' + archiveName + suffix).join(' '))
  const runtime = join(podDir, 'tensorfold-' + TENSORFOLD_HOST_VERSION + '-' + platform)
  check('the tree is kept whole: bin/tensorfold-native beside lib/libtfgrammar.so, the download folder cleaned', existsSync(join(runtime, 'bin', 'tensorfold-native')) && existsSync(join(runtime, 'lib', 'libtfgrammar.so')) && existsSync(join(runtime, 'LICENSE')) && !existsSync(join(podDir, 'release')))
  const argv = readFileSync(calls, 'utf8').trim().split('\n').map(line => line.split('\t').filter(Boolean))
  check('the engine was asked: --version, pull the checkpoint, pull the drafter, then serve with --host 0.0.0.0 --port 8080 --api-key-file', argv.map(row => row[0]).join(' ') === '--version pull pull serve' && argv[1]![1] === 'TensorFold/Qwen3.8-27B-MLX-4bit' && argv[2]![1] === 'z-lab/Qwen3.8-27B-DFlash2' && argv[3]!.join(' ') === 'serve TensorFold/Qwen3.8-27B-MLX-4bit --name qwen3.8-27b --context 131072 --drafter z-lab/Qwen3.8-27B-DFlash2 --host 0.0.0.0 --port 8080 --api-key-file ' + join(podDir, 'api-key'))
  chmodSync(join(podDir, 'api-key'), 0o644)
  const again = run()
  check('a second run keeps the installed runtime (no fetch) and restores the key file to 0600 before serving', again.status === 0 && readFileSync(join(sandbox, 'curl.log'), 'utf8').trim().split('\n').length === 3 && (statSync(join(podDir, 'api-key')).mode & 0o777) === 0o600 && !again.log.includes('MERCURY_STEP downloading'))
  console.log('TENSORFOLD RECIPE SCRIPT GREEN · ' + checks + ' checks · real tar, sha256sum and openssl; curl, nvidia-smi and the engine are fixtures; the release signatures are his published 1.2.2 assets')
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
