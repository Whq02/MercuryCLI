#!/usr/bin/env bun
import '../lib/hermetic.ts'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { readBrushPackManifest } from '../../src/utils/shell/brushPack.ts'

const ROOT = resolve(import.meta.dir, '../..')
const PATCH = 'scripts/vendor/patches/brush-0.4.0-windows.patch'
const SHELL_SHA = '9f0f5029188d3e14cbcd1c43d1ece3d65e74543b079622338b873e1e59317737'
const CORE_SHA = '967a82f3b1bf090db686d5fb86424b19725073828532a42f960d5a13bff14ecb'
const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')
let failures = 0
const check = (label: string, ok: boolean, detail = '') => {
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function run(command: string, args: string[], cwd: string, extraEnv: NodeJS.ProcessEnv = {}) {
  const result = spawnSync(command, args, { cwd, env: { ...process.env, ...extraEnv }, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
  return { rc: result.status, text: (result.stdout ?? '') + (result.stderr ?? '') + (result.error?.message ?? '') }
}
function archive(name: string): string | undefined {
  const cache = join(process.env.CARGO_HOME ?? join(homedir(), '.cargo'), 'registry/cache')
  if (!existsSync(cache)) return undefined
  return readdirSync(cache).map(index => join(cache, index, name)).find(existsSync)
}
const scratch = mkdtempSync(join(tmpdir(), 'windows-shell-patch-'))
try {
  check('the single Windows patch is present', existsSync(join(ROOT, PATCH)))
  if (!existsSync(join(ROOT, PATCH))) throw new Error('missing Windows patch')
  const patch = readFileSync(join(ROOT, PATCH), 'utf8')
  const patchHash = hash(patch)
  const attributes = run('git', ['check-attr', 'eol', '--', PATCH], ROOT)
  check('Windows patch checkouts are pinned to LF', attributes.rc === 0 && attributes.text.trim().endsWith(': eol: lf'), attributes.text.trim())
  const checkout = run('git', ['-c', 'core.autocrlf=true', 'cat-file', '--filters', 'HEAD:' + PATCH], ROOT)
  check('autocrlf does not change the patch bytes', checkout.rc === 0 && hash(checkout.text) === patchHash, `rc=${checkout.rc}`)
  const build = readFileSync(join(ROOT, 'scripts/vendor/build-brush.ts'), 'utf8')
  check('only the pinned core command source is patched', [...patch.matchAll(/^\+\+\+ (.+)$/gm)].map(m => m[1]).join() === 'b/brush-core-0.5.0/src/commands.rs')
  check('Windows-only command composition retains std arguments', patch.includes('+    let command_path = context.shell.working_dir().join(command_name);') && !/^\+.*(?:raw_arg|Command::new\("cmd)/m.test(patch))
  check('the patch carries Windows-only path and cwd-only tests', patch.includes('#[cfg(all(test, windows))]') && patch.includes('paths_are_shell_relative_without_implicit_cwd_search'))
  check('the script fallback is Windows format-error-only and isolates the shell', patch.includes('spawn_err.raw_os_error() == Some(193)') && patch.includes('ext.eq_ignore_ascii_case("sh")') && patch.includes('let mut subshell = context.shell.clone()') && patch.includes('subshell.open_files_mut().set_fd(fd, file)') && patch.includes('Ok(result.exit_code.into())'))
  check('the build applies the patch only for the Windows target', build.includes("SHIP.platform === 'win32' ? await prepareWindowsSource(entry, installRoot) : undefined"))

  const shellArchive = archive('brush-shell-0.4.0.crate')
  const coreArchive = archive('brush-core-0.5.0.crate')
  if (!shellArchive || !coreArchive) {
    console.log('[SKIP] exact crate dry-run and build fixture need the two pinned crates in Cargo registry/cache; prepare the shell pack with cargo first. No network or native Windows result is inferred.')
  } else {
    check('published shell crate matches its pinned sha256', hash(readFileSync(shellArchive)) === SHELL_SHA)
    check('published core crate matches its locked sha256', hash(readFileSync(coreArchive)) === CORE_SHA)
    const source = join(scratch, 'source')
    mkdirSync(source)
    for (const file of [shellArchive, coreArchive]) {
      const unpack = run('tar', ['-xf', file, '-C', source], scratch)
      check('unpack checksum-verified crate', unpack.rc === 0, unpack.text)
    }
    const original = readFileSync(join(source, 'brush-core-0.5.0/src/commands.rs'), 'utf8')
    const dry = run('git', ['apply', '--check', join(ROOT, PATCH)], source)
    check('patch dry-run against the exact published core', dry.rc === 0, dry.text)
    const applied = run('git', ['apply', join(ROOT, PATCH)], source)
    check('patch applies against the exact published core', applied.rc === 0, applied.text)
    const changed = readFileSync(join(source, 'brush-core-0.5.0/src/commands.rs'), 'utf8')
    const unchangedLookup = (text: string) => text.slice(text.indexOf('        // We still haven\'t found a command to invoke.'), text.indexOf('    /// Extracts the owned string representation'))
    check('bare-command lookup and failure are byte-identical', unchangedLookup(original) === unchangedLookup(changed) && unchangedLookup(changed).includes('ErrorKind::CommandNotFound'))
    check('the original command composition was shell-directory blind', !original.includes('context.shell.working_dir().join(command_name)'))

    const fixture = join(scratch, 'build')
    const cargoHome = join(scratch, 'cargo-home')
    for (const name of ['scripts/vendor/build-brush.ts', PATCH, 'src/utils/shell/brushPack.ts', 'src/services/privateChannel/releaseTarget.ts', 'vendor/brush.lock.json']) {
      mkdirSync(dirname(join(fixture, name)), { recursive: true })
      cpSync(join(ROOT, name), join(fixture, name))
    }
    mkdirSync(join(cargoHome, 'registry/cache/fixture'), { recursive: true })
    cpSync(shellArchive, join(cargoHome, 'registry/cache/fixture/brush-shell-0.4.0.crate'))
    const coreSource = join(source, 'brush-core-0.5.0')
    writeFileSync(join(coreSource, 'src/commands.rs'), original)
    const runner = join(scratch, 'build-fixture.ts')
    writeFileSync(runner, `import { mock } from 'bun:test'
import { spawnSync as native } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const realSpawn = native
const root = ${JSON.stringify(fixture)}
const coreSource = ${JSON.stringify(coreSource)}
const coreSha = ${JSON.stringify(CORE_SHA)}
const sha = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex')
const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' })
const refuse = (stderr: string) => ({ status: 1, stdout: '', stderr })
mock.module('node:child_process', () => ({ spawnSync(command: string, args: string[], options: any) {
  if (command === 'rustup') return ok('x86_64-pc-windows-msvc\\n')
  if (command !== 'cargo') return realSpawn(command, args, options)
  if (args[0] === '--version') return ok('cargo fixture: no native compile')
  if (!args.includes('--locked')) return refuse('fixture: --locked missing')
  if (args[0] === 'vendor') {
    const deps = args.at(-1)!
    cpSync(coreSource, join(deps, 'brush-core-0.5.0'), { recursive: true })
    writeFileSync(join(deps, 'brush-core-0.5.0/.cargo-checksum.json'), JSON.stringify({ package: coreSha, files: { 'src/commands.rs': sha(join(coreSource, 'src/commands.rs')) } }))
    return ok('[source.crates-io]\\nreplace-with = "vendored-sources"\\n[source.vendored-sources]\\ndirectory = ' + JSON.stringify(deps) + '\\n')
  }
  if (args[0] === 'install') {
    if (!args.includes('--path') || args.includes('--version')) return refuse('fixture: not built from patched path')
    const source = args[args.indexOf('--path') + 1]
    if (source !== options.cwd) return refuse('fixture: cargo does not read the local source config')
    const core = join(source, '../deps/brush-core-0.5.0')
    const text = readFileSync(join(core, 'src/commands.rs'), 'utf8')
    if (!text.includes('context.shell.working_dir().join(command_name)') || !text.includes('subshell.run_script')) return refuse('fixture: patch not applied before build')
    const checksum = JSON.parse(readFileSync(join(core, '.cargo-checksum.json'), 'utf8'))
    if (checksum.package !== coreSha || checksum.files['src/commands.rs'] !== sha(join(core, 'src/commands.rs'))) return refuse('fixture: package or patched-file checksum wrong')
    if (!existsSync(join(source, '.cargo/config.toml'))) return refuse('fixture: cargo source replacement missing')
    const dest = join(args[args.indexOf('--root') + 1], 'bin')
    mkdirSync(dest, { recursive: true })
    writeFileSync(join(dest, 'brush.exe'), 'fixture binary, not native Windows evidence')
    return ok()
  }
  if (args[0] === 'metadata') {
    const source = options.cwd
    const packages = [
      { id: 'shell', name: 'brush-shell', version: '0.4.0', license: 'MIT', license_file: null, repository: 'https://github.com/reubeno/brush', manifest_path: join(source, 'Cargo.toml') },
      { id: 'core', name: 'brush-core', version: '0.5.0', license: 'MIT', license_file: null, repository: 'https://github.com/reubeno/brush', manifest_path: join(source, '../deps/brush-core-0.5.0/Cargo.toml') },
    ]
    return ok(JSON.stringify({ packages, resolve: { nodes: packages.map(p => ({ id: p.id })) } }))
  }
  return refuse('fixture: unexpected cargo operation ' + args[0])
} }))
const args = process.argv.slice(2)
process.argv = [process.execPath, join(root, 'scripts/vendor/build-brush.ts'), ...args]
await import(join(root, 'scripts/vendor/build-brush.ts'))
`)
    const buildFixture = (args: string[]) => run(process.execPath, [runner, ...args], fixture, { CARGO_HOME: cargoHome })
    console.log('build integration — cargo compilation is a fixture here, git/tar/manifest are real')
    for (const [target, platform] of [['macos-arm64', 'darwin-arm64'], ['macos-x64', 'darwin-x64'], ['linux-x64', 'linux-x64']] as const) {
      const dir = join(fixture, 'vendor/brush', platform)
      mkdirSync(dir, { recursive: true })
      const manifest = JSON.stringify({ platform, source: 'release-archive', control: 'unchanged' })
      writeFileSync(join(dir, '.vendor-manifest.json'), manifest)
      writeFileSync(join(dir, 'brush'), platform)
      const result = buildFixture(['--target', target, '--force'])
      check(`${target}: build skips the fetched pack, manifest and binary byte-identical`, result.rc === 0 && result.text.includes('SKIPPED') && readFileSync(join(dir, '.vendor-manifest.json'), 'utf8') === manifest && readFileSync(join(dir, 'brush'), 'utf8') === platform, result.text.trim())
    }
    const built = buildFixture(['--target', 'windows-x64', '--force'])
    check('Windows build uses the patched locked source and writes the pack', built.rc === 0 && built.text.includes('build-brush: DONE'), built.text.trim())
    const packDir = join(fixture, 'vendor/brush/win-x64')
    const manifestFile = join(packDir, '.vendor-manifest.json')
    const manifest = existsSync(manifestFile) ? JSON.parse(readFileSync(manifestFile, 'utf8')) : {}
    check('manifest records the exact patch and original crate digests', manifest.patchSha256 === patchHash && manifest.crateSha256 === SHELL_SHA)
    check('the product manifest reader preserves the patch digest', readBrushPackManifest(packDir)?.source === 'cargo-build' && (readBrushPackManifest(packDir) as { patchSha256?: string })?.patchSha256 === patchHash)
    check('the patched core and shell licences are retained', existsSync(join(packDir, 'licenses/brush-shell-0.4.0/LICENSE')) && existsSync(join(packDir, 'licenses/brush-core-0.5.0/LICENSE')))
    check('the completed pack revalidates without cargo', buildFixture(['--target', 'windows-x64', '--check']).rc === 0)

    console.log('refusals')
    for (const bad of [undefined, '0'.repeat(64), 'not-a-digest']) {
      writeFileSync(manifestFile, JSON.stringify({ ...manifest, patchSha256: bad }))
      const stale = buildFixture(['--target', 'windows-x64', '--check'])
      check(`absent, changed or malformed patch digest refuses reuse (${String(bad)})`, stale.rc === 2 && stale.text.includes('STALE'), stale.text.trim())
    }
    writeFileSync(manifestFile, JSON.stringify(manifest))
    const savedPatch = readFileSync(join(fixture, PATCH), 'utf8')
    writeFileSync(join(fixture, PATCH), savedPatch.replace('    let mut cmd = std::process::Command::new(command_name);', '    nonexistent pinned preimage'))
    const badPatch = buildFixture(['--target', 'windows-x64', '--force'])
    check('a drifted patch refuses before a replacement pack is installed', badPatch.rc === 1 && badPatch.text.includes('patch check failed') && readFileSync(manifestFile, 'utf8') === JSON.stringify(manifest), badPatch.text.trim())
    writeFileSync(join(fixture, PATCH), savedPatch)
    writeFileSync(join(cargoHome, 'registry/cache/fixture/brush-shell-0.4.0.crate'), 'changed crate')
    const badCrate = buildFixture(['--target', 'windows-x64', '--force'])
    check('a changed crate refuses before extraction and pack replacement', badCrate.rc === 1 && badCrate.text.includes('sha256 mismatch before extraction') && readFileSync(manifestFile, 'utf8') === JSON.stringify(manifest), badCrate.text.trim())

    const rustc = [join(homedir(), '.cargo/bin', process.platform === 'win32' ? 'rustc.exe' : 'rustc'), 'rustc'].find(bin => run(bin, ['--version'], scratch).rc === 0)
    if (!rustc) console.log('[SKIP] Rust path-logic mirror needs rustc; no Windows execution is inferred')
    else {
      const start = changed.indexOf('    #[cfg(windows)]\n    let command_path')
      const end = changed.indexOf('    let mut cmd = std::process::Command::new(command_name);', start)
      const composition = changed.slice(start, end).replaceAll('    #[cfg(windows)]\n', '')
      const lookup = readFileSync(join(coreSource, 'src/sys/windows/fs.rs'), 'utf8')
      const lookupBody = lookup.slice(lookup.indexOf('static PATHEXT_EXTENSIONS'), lookup.indexOf('impl crate::sys::fs::PathExt'))
      const mirror = join(scratch, 'path-mirror.rs')
      writeFileSync(mirror, `use std::{ffi::OsStr, path::{Path, PathBuf}, sync::LazyLock};
struct Shell { cwd: PathBuf }
impl Shell { fn working_dir(&self) -> &Path { &self.cwd } }
struct Context { shell: Shell }
fn compose(context: &Context, command_name: &str, args: &[&str]) -> std::io::Result<std::process::Command> {
${composition}    let mut cmd = std::process::Command::new(command_name);
    cmd.args(args).current_dir(context.shell.working_dir());
    Ok(cmd)
}
${lookupBody}
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let root = std::env::current_dir()?;
    let context = Context { shell: Shell { cwd: root.join("work") } };
    std::fs::create_dir_all(context.shell.working_dir())?;
    let bin = root.join("bin");
    std::fs::create_dir_all(&bin)?;
    for name in ["./x", "../x", "sub/x"] {
        let cmd = compose(&context, name, &["%VAR%", "^", "a b", ""])?;
        assert_eq!(Path::new(cmd.get_program()), context.shell.working_dir().join(name));
        assert_eq!(cmd.get_args().collect::<Vec<_>>(), ["%VAR%", "^", "a b", ""]);
    }
    for name in ["./bad\\\".cmd", "./bad\\n.cmd", "./bad\\r.bat"] { assert!(compose(&context, name, &[]).is_err()); }
    std::fs::write(context.shell.working_dir().join("cwd-only.cmd"), "CWD_SHIM_MUST_NOT_RUN")?;
    std::fs::write(bin.join("shim-probe.cmd"), "PATH_SHIM_OK")?;
    assert_eq!(resolve_executable(bin.join("shim-probe")), Some(bin.join("shim-probe.cmd")));
    assert!(resolve_executable(bin.join("cwd-only")).is_none());
    println!("PASS host mirror: relative program paths, literal argument vectors, batch-path refusals, PATH-only lookup");
    Ok(())
}
`)
      const exe = join(scratch, process.platform === 'win32' ? 'path-mirror.exe' : 'path-mirror')
      const compile = run(rustc, ['--edition', '2024', mirror, '-o', exe], scratch)
      check('host-runnable mirror compiles the actual composition and lookup declarations', compile.rc === 0, compile.text)
      if (compile.rc === 0) {
        const result = run(exe, [], scratch)
        check('host path mirror and refusals pass (not native cmd.exe evidence)', result.rc === 0 && result.text.includes('PASS host mirror'), result.text.trim())
      }
    }
  }
} catch (error) {
  check('Windows shell patch proof completes', false, String(error))
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
console.log(failures === 0 ? 'PASS Windows shell patch and refusals' : `FAIL Windows shell patch and refusals (${failures})`)
process.exit(failures === 0 ? 0 : 1)
