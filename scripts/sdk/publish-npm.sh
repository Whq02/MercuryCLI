#!/usr/bin/env bash
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"
push=false
case "${1:-}" in '') ;; --push) push=true ;; *) echo 'usage: publish-npm.sh [--push]' >&2; exit 2;; esac
[ "$#" -le 1 ] || exit 2
node "$root/node_modules/typescript/bin/tsc" -p "$root/sdk/tsconfig.json"
node --input-type=module - "$root/sdk/package.json" <<'JS'
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
const p = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
if (p.name !== 'mercury-cli-sdk' || p.version !== '0.1.0' || p.private) throw new Error('unexpected package identity')
const r = await fetch(`https://registry.npmjs.org/${p.name}`)
if (r.status === 404) console.log(`${new Date().toISOString()} npm ${p.name}: free (HTTP 404)`)
else if (r.ok) {
  const metadata = await r.json()
  const owner = execFileSync('npm', ['whoami', '--registry=https://registry.npmjs.org'], { encoding: 'utf8' }).trim()
  if (!metadata.maintainers?.some(m => m.name === owner)) throw new Error('authenticated npm user is not a package maintainer')
  if (metadata.versions?.[p.version]) throw new Error('version already published')
  console.log(`npm ${p.name}: authenticated maintainer verified`)
} else throw new Error(`registry check failed: HTTP ${r.status}`)
JS
(cd "$root/sdk" && npm pack --dry-run --ignore-scripts)
if $push; then
  (cd "$root/sdk" && npm publish --access public --ignore-scripts)
else
  printf '\nDRY RUN: would publish mercury-cli-sdk@0.1.0 to npm; nothing uploaded.\n'
fi
