const PRELUDE = String.raw`LC_ALL=C; export LC_ALL
N='
'
T=
[ -n "$ZSH_VERSION" ] && emulate sh
trap 'exit 129' HUP
trap 'exit 143' TERM
trap 'if [ -n "$T" ]; then rm -f "$T"; fi' EXIT
if printf x | head -c 1 >/dev/null 2>&1; then m_take() { head -c "$1"; }; else m_take() { dd bs=1 count="$1" 2>/dev/null; }; fi
m_end() { s=$?; printf '\n%s %s\n' "$1" "$s"; printf '%s\n' "$1" >&2; }
m_put() {
  T=$2
  true > "$2" || { T=; return 73; }
  printf '%s\n' "$3"
  if [ "$1" -gt 0 ]; then m_take "$1" >> "$2" || exit 97; fi
  [ "$(wc -c < "$2")" -eq "$1" ] || exit 97
}
m_loop() {
  printf '%s\n' "$1"; printf '%s\n' "$1" >&2
  while IFS= read -r req; do
    case $req in
      "$K "*) eval "@{req#"$K "}" ;;
      *) exit 98 ;;
    esac
  done
}
`.replaceAll('@{', '$' + '{')

export function remotePrelude(token: string, ready: string): string {
  return `K=${token}\n${PRELUDE}m_loop ${ready}\n`
}

export function remoteQuote(text: string): string {
  return text
    .split('\n')
    .map(part => `'${part.replaceAll("'", "'\\''")}'`)
    .join('"$N"')
}
