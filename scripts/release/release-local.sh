#!/usr/bin/env bash
set -u

usage() {
  cat <<'EOF'
usage: bash scripts/release/release-local.sh --target <release target> [options]

The release workflow's package job for ONE target, run on a machine of our own: the steps of
.github/workflows/private-release.yml (the package job, then the bridge-gate job) in the same
order, each step's exit code on its own line. The first red stops this target and names the
step. Nothing publishes: the archive lands in release-out/ as the packager writes it.

options
  --target <t>             linux-x64 | linux-arm64 | macos-arm64 | macos-x64
                           (the Windows targets build on a Windows machine: field/inbox packet)
  --root <tree>            the checkout to build (default: the tree this script sits in)
  --out <dir>              copy the archive there and refresh <dir>/SHA256SUMS.txt
  --logs <dir>             per-step logs (default: <root>/release-out/release-local-logs/<target>)
  --unsigned               ship without the release key, by decision (the name says -unsigned)
  --skip <steps>           comma list to leave out: install, fetch, node-pin, rosetta,
                           shell-engine, native (rust-target voice cmake whisper desktop embed
                           embed-model), build, package, verify, collect, bridge
                           (bridge-rosetta bridge-journey bridge-reader)
  --packager-flag <flag>   handed to package.mjs as given (repeatable):
                           --allow-stale-verify-receipts, --allow-degraded, --license-id <id>
  --help

environment
  MERCURY_SIGNING_KEY_FILE   the release key's PEM file: package.mjs reads it; nothing here
                             prints, copies or logs it
  MERCURY_RELEASE_LOCAL_HOME scratch config home for every child (default: a fresh temp dir)
  MERCURY_BRIDGE_PREVIOUS    the previous release's asset for this target, already downloaded
  MERCURY_BRIDGE_PREVIOUS_TAG  its tag

lines
  step <name> rc=<n> [tolerated | skipped]
  TARGET <t> OK archive=<path> sha256=<hex>
  TARGET <t> RED at <step> rc=<n> log=<file>
EOF
}

TARGET=''
ROOT=''
OUT=''
LOGS=''
UNSIGNED=0
SKIP=''
PACKAGER_FLAGS=''
while [ $# -gt 0 ]; do
  case "$1" in
    --target) TARGET=${2:-}; shift 2 ;;
    --root) ROOT=${2:-}; shift 2 ;;
    --out) OUT=${2:-}; shift 2 ;;
    --logs) LOGS=${2:-}; shift 2 ;;
    --unsigned) UNSIGNED=1; shift ;;
    --skip) SKIP="$SKIP,${2:-}"; shift 2 ;;
    --packager-flag) PACKAGER_FLAGS="$PACKAGER_FLAGS ${2:-}"; shift 2 ;;
    --help | -h) usage; exit 0 ;;
    *) echo "release-local: unknown argument $1" >&2; usage >&2; exit 2 ;;
  esac
done

case "$TARGET" in
  linux-x64) NODE_PACK=linux-x64; RUST_TRIPLE=x86_64-unknown-linux-gnu ;;
  linux-arm64) NODE_PACK=linux-arm64; RUST_TRIPLE=aarch64-unknown-linux-gnu ;;
  macos-arm64) NODE_PACK=darwin-arm64; RUST_TRIPLE=aarch64-apple-darwin ;;
  macos-x64) NODE_PACK=darwin-x64; RUST_TRIPLE=x86_64-apple-darwin ;;
  '') echo "release-local: --target is required" >&2; usage >&2; exit 2 ;;
  *) echo "release-local: --target wants linux-x64, linux-arm64, macos-arm64 or macos-x64 (got $TARGET)" >&2; exit 2 ;;
esac

[ -n "$ROOT" ] || ROOT=$(cd "$(dirname "$0")/../.." && pwd)
ROOT=$(cd "$ROOT" && pwd) || { echo "release-local: --root $ROOT is not a directory" >&2; exit 2; }
[ -f "$ROOT/scripts/release/package.mjs" ] || { echo "release-local: $ROOT carries no scripts/release/package.mjs" >&2; exit 2; }
git -C "$ROOT" rev-parse --verify HEAD > /dev/null 2>&1 || { echo "release-local: git cannot read $ROOT as a repository with a HEAD (the build stamps its content tree from git, and the packager binds that tree to the gate ledger): $(git -C "$ROOT" rev-parse HEAD 2>&1 | head -1)" >&2; exit 2; }
[ -n "$LOGS" ] || LOGS="$ROOT/release-out/release-local-logs/$TARGET"
mkdir -p "$LOGS" || exit 2
LOGS=$(cd "$LOGS" && pwd)
if [ -n "$OUT" ]; then mkdir -p "$OUT" || exit 2; OUT=$(cd "$OUT" && pwd); fi

case "$(uname -s)/$(uname -m)" in
  Darwin/arm64) HOST=macos-arm64; HOST_PACK=darwin-arm64 ;;
  Darwin/x86_64) HOST=macos-x64; HOST_PACK=darwin-x64 ;;
  Linux/x86_64) HOST=linux-x64; HOST_PACK=linux-x64 ;;
  Linux/aarch64 | Linux/arm64) HOST=linux-arm64; HOST_PACK=linux-arm64 ;;
  *) echo "release-local: no release target runs on $(uname -s)/$(uname -m)" >&2; exit 2 ;;
esac
CROSS=0
if [ "$HOST" != "$TARGET" ]; then
  CROSS=1
  case "$HOST/$TARGET" in
    macos-arm64/macos-x64) ;;
    *) echo "release-local: the workflow cross-packages only the Intel Mac archive on Apple silicon; $TARGET is built natively, not on $HOST" >&2; exit 2 ;;
  esac
fi

if [ "$UNSIGNED" = 1 ]; then
  [ -z "${MERCURY_SIGNING_KEY_FILE:-}" ] || { echo "release-local: --unsigned given with MERCURY_SIGNING_KEY_FILE set — choose one: sign with the key, or ship unsigned by decision" >&2; exit 2; }
  EXPECT=unsigned
  PACKAGER_FLAGS="$PACKAGER_FLAGS --unsigned"
else
  [ -n "${MERCURY_SIGNING_KEY_FILE:-}" ] || { echo "release-local: no MERCURY_SIGNING_KEY_FILE and no --unsigned — an unsigned archive is a decision, never an accident: name the release key's PEM file in MERCURY_SIGNING_KEY_FILE, or pass --unsigned deliberately" >&2; exit 2; }
  [ -r "$MERCURY_SIGNING_KEY_FILE" ] || { echo "release-local: MERCURY_SIGNING_KEY_FILE names no readable file" >&2; exit 2; }
  EXPECT=signed
fi

for tool in git bun node tar; do command -v "$tool" > /dev/null 2>&1 || { echo "release-local: $tool is not on PATH" >&2; exit 2; }; done

HOME_SCRATCH=${MERCURY_RELEASE_LOCAL_HOME:-$(mktemp -d "${TMPDIR:-/tmp}/mercury-release-local-home.XXXXXX")}
mkdir -p "$HOME_SCRATCH"
export MERCURY_CONFIG_DIR="$HOME_SCRATCH" MERCURY_CREDENTIAL_STORE=file BROWSER=/usr/bin/true CI=1 MERCURY_LOCAL_PROBE_TARGETS=none
unset MERCURY_HOME MERCURY_CRITTER
WORK=$(mktemp -d "${TMPDIR:-/tmp}/mercury-release-local-work.XXXXXX")

VERSION=$(node -p "require('$ROOT/package.json').version")
NODE_PIN=$(tr -d '[:space:]' < "$ROOT/.node-version")
echo "release-local: $TARGET ($([ "$CROSS" = 1 ] && echo "cross from $HOST" || echo native)) · version $VERSION · tree $(git -C "$ROOT" rev-parse --short HEAD) ($(git -C "$ROOT" status --porcelain | wc -l | tr -d ' ') uncommitted path(s)) · node pin $NODE_PIN · signing: $([ "$UNSIGNED" = 1 ] && echo 'UNSIGNED by decision' || echo 'key file present')"
echo "release-local: logs $LOGS"

is_skipped() {
  case ",$SKIP," in
    *",$1,"*) return 0 ;;
  esac
  case "$1" in
    rust-target | voice | cmake | whisper | desktop | embed | embed-model) case ",$SKIP," in *",native,"*) return 0 ;; esac ;;
    bridge-rosetta | bridge-journey | bridge-reader) case ",$SKIP," in *",bridge,"*) return 0 ;; esac ;;
  esac
  return 1
}

STEP_N=1
sha256_of() {
  if command -v sha256sum > /dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}
red() {
  echo "TARGET $TARGET RED at $1 rc=$2 log=$3"
  exit 1
}
step() {
  local name=$1 tolerated=$2 log rc
  shift 2
  log=$LOGS/$(printf '%02d' "$STEP_N")-$name.log
  STEP_N=$((STEP_N + 1))
  if is_skipped "$name"; then echo "step $name skipped"; return 0; fi
  (cd "$ROOT" && "$@") > "$log" 2>&1
  rc=$?
  if [ "$rc" = 0 ]; then echo "step $name rc=0"; return 0; fi
  if [ "$tolerated" = 1 ]; then
    echo "step $name rc=$rc tolerated"
    tail -3 "$log" | sed 's/^/    /'
    return 0
  fi
  echo "step $name rc=$rc"
  tail -15 "$log" | sed 's/^/    /'
  red "$name" "$rc" "$log"
}

rosetta_check() {
  if arch -x86_64 /usr/bin/true 2> /dev/null; then echo "Rosetta 2 runs x86_64 binaries on this Mac"; return 0; fi
  echo "Rosetta 2 is absent: the $TARGET archive's own runtime is an x86_64 binary and the friend-path smoke boots it here under Rosetta. Install it once (an administrator): softwareupdate --install-rosetta --agree-to-license"
  return 1
}
node_pin() {
  local pack="$ROOT/vendor/node/extracted/$HOST_PACK/bin/node" have
  if [ -x "$pack" ] && [ "$("$pack" --version)" = "v$NODE_PIN" ]; then
    echo "the packager and the smoke run on the vendored host runtime $pack (v$NODE_PIN, the calibration pin)"
    echo "$(dirname "$pack")" > "$WORK/node-bin"
    return 0
  fi
  have=$(node --version)
  if [ "$have" = "v$NODE_PIN" ]; then echo "PATH node is $have, the calibration pin"; return 0; fi
  echo "note: PATH node is $have; the calibration pin is v$NODE_PIN and no vendored host pack serves it (bun run scripts/vendor/fetch-node.ts --platform $HOST_PACK prepares one). The archive carries its own runtime; the packager and the smoke run on $have."
  return 0
}
cmake_check() { cmake --version; }
rust_target() { rustup target add "$RUST_TRIPLE"; }
build_manifest_facts() {
  node -e '
const m = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))
const t = m.target && typeof m.target === "object" ? m.target.release : null
console.log(`manifest: target ${t} · runtime ${m.runtime && m.runtime.vendored ? `node ${m.runtime.version} ${m.runtime.platform}` : "NONE"} · degraded ${JSON.stringify(m.degraded ?? [])} · buildTree ${m.buildTree}`)
if (t !== process.argv[2]) { console.error(`the build declares ${t}, not ${process.argv[2]}`); process.exit(1) }
' "$ROOT/dist/manifest.json" "$TARGET"
}
with_node() {
  if [ -s "$WORK/node-bin" ]; then PATH="$(cat "$WORK/node-bin"):$PATH" "$@"; else "$@"; fi
}
package_step() {
  with_node node scripts/release/package.mjs --target "$TARGET" $PACKAGER_FLAGS
}
archive_name() {
  with_node node -e '
const { archiveNameFor } = await import(process.argv[1])
const { unsignedArchiveName } = await import(process.argv[2])
const name = archiveNameFor(process.argv[3], process.argv[4])
console.log(process.argv[5] === "1" ? unsignedArchiveName(name) : name)
' --input-type=module "file://$ROOT/dist/verify-artifact.mjs" "file://$ROOT/scripts/release/payloadContract.mjs" "$VERSION" "$TARGET" "$UNSIGNED" 2> /dev/null
}
verify_step() {
  with_node node scripts/release/verifyArchive.mjs --archive "$1" --expect "$EXPECT"
}
collect_step() {
  local archive=$1 f
  [ -n "$OUT" ] || { echo "no --out: the archive stays at $archive"; return 0; }
  cp "$archive" "$OUT/" || return 1
  (cd "$OUT" && for f in mercury-*.tar.gz mercury-*.zip; do [ -e "$f" ] || continue; if command -v sha256sum > /dev/null 2>&1; then sha256sum "$f"; else shasum -a 256 "$f"; fi; done > SHA256SUMS.txt) || return 1
  echo "collected $(basename "$archive") into $OUT; SHA256SUMS.txt refreshed over $(grep -c . "$OUT/SHA256SUMS.txt") archive(s)"
}
journey_step() {
  local archive=$1 extract=$WORK/bridge-extract
  rm -rf "$extract" && mkdir -p "$extract" && tar -xzf "$archive" -C "$extract" || return 1
  with_node env MERCURY_JOURNEY_DIST="$extract/mercury/mercury.mjs" bun run scripts/updater/prove-update-journey.ts
}
bridge_reader_step() {
  with_node env MERCURY_BRIDGE_CANDIDATE="$1" bun run scripts/updater/prove-release-bridge.ts --target "$TARGET"
}
rosetta_archive_step() {
  with_node bun run scripts/updater/prove-cross-archive-rosetta.ts --target "$TARGET" --require
}

step install 0 bun install --frozen-lockfile
HOST_PACK_FETCH=''
[ "$CROSS" = 1 ] && HOST_PACK_FETCH="--platform $HOST_PACK"
step fetch 0 sh -c 'bun run scripts/vendor/fetch-pyright.ts && bun run scripts/vendor/fetch-debugpy.ts && bun run scripts/vendor/fetch-js-debug.ts && bun run scripts/vendor/fetch-grammars.ts && bun run scripts/vendor/fetch-node.ts --platform "$1" $3 && bun run scripts/vendor/fetch-platform-packages.ts --target "$2"' fetch "$NODE_PACK" "$TARGET" "$HOST_PACK_FETCH"
step node-pin 0 node_pin
[ "$CROSS" = 1 ] && step rosetta 0 rosetta_check
step shell-engine 0 bun run scripts/vendor/fetch-brush.ts --platform "$NODE_PACK"
[ "$CROSS" = 1 ] && step rust-target 1 rust_target
step voice 1 bun run scripts/vendor/build-voice.ts --target "$TARGET"
step cmake 1 cmake_check
step whisper 1 bun run scripts/vendor/build-whisper.ts --target "$TARGET"
step desktop 1 bun run scripts/vendor/build-desktop.ts --target "$TARGET"
step embed 1 bun run scripts/vendor/build-embed.ts --target "$TARGET"
step embed-model 1 bun run scripts/vendor/fetch-embed-models.ts --default
step build 0 sh -c 'bun run build.ts --target "$1"' build "$TARGET"
step manifest 0 build_manifest_facts
step package 0 package_step
ARCHIVE_NAME=$(archive_name)
[ -n "$ARCHIVE_NAME" ] || { echo "release-local: the archive name could not be read from the built library"; red package 1 "$LOGS"; }
ARCHIVE=$ROOT/release-out/$ARCHIVE_NAME
[ -f "$ARCHIVE" ] || is_skipped package || { echo "release-local: the packager wrote no $ARCHIVE"; red package 1 "$LOGS"; }
step verify 0 verify_step "$ARCHIVE"
step collect 0 collect_step "$ARCHIVE"
[ "$CROSS" = 1 ] && step bridge-rosetta 0 rosetta_archive_step
step bridge-journey 0 journey_step "$ARCHIVE"
step bridge-reader 0 bridge_reader_step "$ARCHIVE"
rm -rf "$WORK"
if [ -f "$ARCHIVE" ]; then
  echo "TARGET $TARGET OK archive=$ARCHIVE sha256=$(sha256_of "$ARCHIVE")"
else
  echo "TARGET $TARGET OK archive=(package skipped)"
fi
