#!/bin/sh
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
bin="${FAKE_OLLAMA_BIN:?FAKE_OLLAMA_BIN names the directory the fixture ollama is installed into}"
mkdir -p "$bin"
printf '#!/bin/sh\nexec "%s/ollama" "$@"\n' "$here" > "$bin/ollama.tmp"
chmod 755 "$bin/ollama.tmp"
mv -f "$bin/ollama.tmp" "$bin/ollama"
echo ">>> Installing ollama to $bin"
echo ">>> The Ollama fixture is now available at $bin/ollama"
echo ">>> Install complete. Run \"ollama\" from the command line."
