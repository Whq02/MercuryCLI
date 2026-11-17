#!/usr/bin/env bash
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"
package="${MERCURY_SDK_PYTHON_PACKAGE:-$root/sdk-py}"
push=false
case "${1:-}" in '') ;; --push) push=true ;; *) echo 'usage: publish-pypi.sh [--push]' >&2; exit 2;; esac
[ "$#" -le 1 ] || exit 2
python3 -m twine --version >/dev/null 2>&1 || { echo "publish-pypi.sh: python3 has no twine module, so the upload cannot start; install twine for it, or run: uv run --no-project --with twine --python $(command -v python3 || echo python3) bash scripts/sdk/publish-pypi.sh${1:+ $1}" >&2; exit 1; }
rm -rf "$package/dist"
python3 "$package/build_backend.py" "$package/dist"
python3 - "$package" <<'PY'
import datetime, json, pathlib, sys, tomllib, urllib.error, urllib.request, zipfile
package = pathlib.Path(sys.argv[1])
p = tomllib.loads((package / 'pyproject.toml').read_text())['project']
assert p['name'] == 'mercury-cli-sdk' and p['version'] == '0.2.0'
try:
    response = urllib.request.urlopen('https://pypi.org/pypi/mercury-cli-sdk/json')
except urllib.error.HTTPError as error:
    if error.code != 404: raise
    print(f'{datetime.datetime.now(datetime.timezone.utc).isoformat()} PyPI mercury-cli-sdk: free (HTTP 404)')
else:
    with response:
        metadata = json.load(response)
    if p['version'] in metadata.get('releases', {}):
        raise SystemExit(f"{p['name']} {p['version']} is already published on PyPI.")
wheel = package / 'dist/mercury_cli_sdk-0.2.0-py3-none-any.whl'
with zipfile.ZipFile(wheel) as z:
    for name in z.namelist(): print(name)
for name in ('mercury_cli_sdk-0.2.0-py3-none-any.whl', 'mercury_cli_sdk-0.2.0.tar.gz'):
    f = package / 'dist' / name
    print(f'{f.name}: {f.stat().st_size} bytes')
PY
if $push; then
  python3 -m twine upload --repository pypi "$package/dist/mercury_cli_sdk-0.2.0-py3-none-any.whl" "$package/dist/mercury_cli_sdk-0.2.0.tar.gz"
else
  printf '\nDRY RUN: would publish mercury-cli-sdk 0.2.0 wheel and sdist to PyPI; nothing uploaded.\n'
fi
