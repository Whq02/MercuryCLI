#!/usr/bin/env bash
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"
package="${MERCURY_SDK_PYTHON_PACKAGE:-$root/sdk-py}"
push=false
case "${1:-}" in '') ;; --push) push=true ;; *) echo 'usage: publish-pypi.sh [--push]' >&2; exit 2;; esac
[ "$#" -le 1 ] || exit 2
rm -rf "$package/dist"
python3 "$package/build_backend.py" "$package/dist"
python3 - "$package" <<'PY'
import datetime, pathlib, sys, tomllib, urllib.error, urllib.request, zipfile
package = pathlib.Path(sys.argv[1])
p = tomllib.loads((package / 'pyproject.toml').read_text())['project']
assert p['name'] == 'mercury-cli-sdk' and p['version'] == '0.1.0'
try:
    response = urllib.request.urlopen('https://pypi.org/pypi/mercury-cli-sdk/json')
except urllib.error.HTTPError as error:
    if error.code != 404: raise
    print(f'{datetime.datetime.now(datetime.timezone.utc).isoformat()} PyPI mercury-cli-sdk: free (HTTP 404)')
else:
    response.close()
    raise SystemExit('The name exists. Public PyPI metadata cannot prove upload ownership; refusing. Verify authenticated project access before preparing a subsequent release.')
wheel = package / 'dist/mercury_cli_sdk-0.1.0-py3-none-any.whl'
with zipfile.ZipFile(wheel) as z:
    for name in z.namelist(): print(name)
for name in ('mercury_cli_sdk-0.1.0-py3-none-any.whl', 'mercury_cli_sdk-0.1.0.tar.gz'):
    f = package / 'dist' / name
    print(f'{f.name}: {f.stat().st_size} bytes')
PY
if $push; then
  python3 -m twine upload --repository pypi "$package/dist/mercury_cli_sdk-0.1.0-py3-none-any.whl" "$package/dist/mercury_cli_sdk-0.1.0.tar.gz"
else
  printf '\nDRY RUN: would publish mercury-cli-sdk 0.1.0 wheel and sdist to PyPI; nothing uploaded.\n'
fi
