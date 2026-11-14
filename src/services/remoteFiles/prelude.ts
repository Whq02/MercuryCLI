const PRELUDE = String.raw`LC_ALL=C; export LC_ALL
N='
'
T=
B=
O=
b=
[ -n "$ZSH_VERSION" ] && emulate sh
trap 'exit 129' HUP
trap 'exit 143' TERM
trap 'if [ -n "$b" ]; then kill "$b" 2>/dev/null; fi; if [ -n "$T" ]; then rm -f "$T"; fi; if [ -n "$B" ]; then if [ -n "$O" ] && [ -f "$B" ]; then cat "$B" > "$O"; fi; rm -f "$B"; fi' EXIT
if printf x | head -c 1 >/dev/null 2>&1; then m_take() { head -c "$1"; }; else m_take() { dd bs=1 count="$1" 2>/dev/null; }; fi
m_beat() {
  z=
  trap 'if [ -n "$z" ]; then kill "$z" 2>/dev/null; fi; exit 0' TERM
  while kill -0 $$ 2>/dev/null; do
    sleep "$1" &
    z=$!
    wait "$z"
    printf '\a' >&2 || exit 0
  done
}
m_end() { s=$?; printf '\n%s %s\n' "$1" "$s"; printf '%s\n' "$1" >&2; }
m_put() {
  T=$2
  true > "$2" || { T=; return 73; }
  printf '%s\n' "$3"
  if [ "$1" -gt 0 ]; then m_take "$1" >> "$2" || exit 97; fi
  [ "$(wc -c < "$2")" -eq "$1" ] || exit 97
}
if stat -c '%s %Y %a' / >/dev/null 2>&1; then m_meta() { stat -L -c '%s %Y %a' "$1" 2>/dev/null; }
elif stat -f '%z %m %Lp' / >/dev/null 2>&1; then m_meta() { stat -L -f '%z %m %Lp' "$1" 2>/dev/null; }
else m_meta() { printf '%s 0 -\n' "$(wc -c < "$1" 2>/dev/null | tr -d ' ')"; }
fi
m_sum() { c=$(cksum < "$1") || return 1; set -- $c; printf '%s %s\n' "$1" "$2"; }
m_facts() {
  if [ -n "$1" ] && [ -e "$1" ]; then h=1; else h=0; fi
  printf '%s\0%s\0%s\0%s\0' "$HOME" "$(uname -s 2>/dev/null)" "$h" "$(rg --no-config --version 2>/dev/null | head -n 1)"
}
m_home() { eval "printf '%s\n' ~$1"; }
m_kind() {
  if [ -L "$1" ]; then l=l; else l=-; fi
  if [ -d "$1" ]; then t=d
  elif [ -f "$1" ]; then t=f
  elif [ -p "$1" ]; then t=p
  elif [ -S "$1" ]; then t=s
  elif [ -b "$1" ] || [ -c "$1" ]; then t=c
  elif [ -e "$1" ]; then t=o
  elif [ "$l" = l ]; then t=x
  else return 44
  fi
  m=$(m_meta "$1") && [ -n "$m" ] || m='- - -'
  h=
  if [ "$2" = 1 ] && [ "$t" = f ]; then h=$(m_take 64 < "$1" 2>/dev/null | od -An -tx1 | tr -d ' \n'); fi
  printf '%s %s %s %s\n' "$t" "$l" "$m" "@{h:--}"
}
m_real() {
  p=$1; n=0
  while [ -L "$p" ] && [ "$n" -lt 40 ]; do
    t=$(readlink "$p") || break
    case $t in /*) p=$t ;; *) p=$(dirname "$p")/$t ;; esac
    n=$((n + 1))
  done
  if [ -d "$p" ]; then r=$(cd -P "$p" 2>/dev/null && pwd -P) || r=$p; printf '%s\n' "$r"; return 0; fi
  d=$(dirname "$p"); q=$(basename "$p")
  r=$(cd -P "$d" 2>/dev/null && pwd -P) || r=$d
  case $r in /) printf '/%s\n' "$q" ;; *) printf '%s/%s\n' "$r" "$q" ;; esac
}
m_head() {
  if [ -d "$1" ]; then return 45; fi
  if [ ! -e "$1" ]; then if [ -L "$1" ]; then return 46; fi; return 44; fi
  if [ ! -f "$1" ]; then return 46; fi
  m=$(m_meta "$1") && [ -n "$m" ] || return 47
  l=$(wc -l < "$1") || return 47
  if [ "$(tail -c 1 "$1" | wc -l)" -eq 1 ]; then e=1; else e=0; fi
  g=$(m_take 3 < "$1" | od -An -tx1 | tr -d ' \n')
  [ -n "$g" ] || g=-
  set -- "$1" $m
  if [ "$2" -le 1073741824 ]; then c=$(m_sum "$1") || return 47; else c='- -'; fi
  printf '%s %s %s %s %s %s %s\n' "$2" "$3" "$4" $l "$e" "$g" "@{c% *}"
}
m_page() {
  h=$(m_head "$1") || return
  printf '%s\n' "$h"
  set -- "$1" "$2" "$3" "$4" $h
  if [ "$4" -gt 0 ] && [ "$5" -gt "$4" ]; then return 48; fi
  if [ "$3" -gt 0 ]; then sed -n "$2,$(($2 + $3 - 1))p;$(($2 + $3 - 1))q" "$1"
  elif [ "$3" -lt 0 ] && [ "$2" -le 1 ]; then cat "$1"
  elif [ "$3" -lt 0 ]; then tail -n "+$2" "$1"
  fi
}
m_list() {
  if [ ! -d "$1" ]; then if [ -e "$1" ] || [ -L "$1" ]; then return 46; fi; return 44; fi
  if [ ! -r "$1" ] || [ ! -x "$1" ]; then return 47; fi
  ( cd "$1" || exit 47
    for f in * .[!.]* ..?*; do
      if [ -L "$f" ]; then t=l; if [ "$2" = 1 ]; then t=l$(m_real "$1/$f"); fi
      elif [ -d "$f" ]; then t=d; elif [ -f "$f" ]; then t=f; elif [ -e "$f" ]; then t=o; else continue; fi
      printf '%s\0%s\0' "$t" "$f"
    done )
}
if stat -c '%s %Y %A %n' / >/dev/null 2>&1; then m_found() { find "$@" -exec stat -c '%s %Y %A %n' {} + 2>/dev/null; }
elif stat -f '%z %m %Sp %N' / >/dev/null 2>&1; then m_found() { find "$@" -exec stat -f '%z %m %Sp %N' {} + 2>/dev/null; }
else m_found() { find "$@" -exec sh -c 'for f; do if [ -d "$f" ]; then printf "0 0 d %s\n" "$f"; else printf "0 0 - %s\n" "$f"; fi; done' sh {} + 2>/dev/null; }
fi
m_walk() {
  r=$1; d=$2; shift 2
  if [ ! -e "$r" ]; then if [ -L "$r" ]; then return 46; fi; return 44; fi
  c=$#
  if [ "$c" -gt 0 ]; then
    set -- "$@" \(
    i=0
    while [ "$i" -lt "$c" ]; do
      if [ "$i" -gt 0 ]; then set -- "$@" -o; fi
      set -- "$@" -name "$1"
      shift
      i=$((i + 1))
    done
    set -- "$@" \)
  fi
  if [ "$d" -gt 0 ]; then D="-maxdepth $d"; else D=; fi
  if [ "$c" -gt 0 ]; then Y='( -type f -o -type d )'; else Y='-type f'; fi
  m_found "$r" $D \( -type d \( -name .git -o -name .svn -o -name .hg -o -name .bzr -o -name .jj -o -name .sl \) -prune -o $Y "$@" \)
  return 0
}
m_has() { for f; do if [ -e "$f" ]; then printf 1; else printf 0; fi; done; }
m_cat() {
  k=$1; shift
  while [ $# -gt 1 ]; do
    w=c
    if [ "$1" = s ] && [ "$(m_take 512 < "$2" 2>/dev/null | tr -d '\000' | wc -c)" -lt 512 ]; then
      case $(m_take 2 < "$2" 2>/dev/null | od -An -tx1 | tr -d ' \n') in fffe|feff) ;; *) w=s ;; esac
    fi
    if [ $w = s ]; then m_take 512 < "$2" 2>/dev/null; else cat "$2" 2>/dev/null; fi
    printf '\n%s %s\n' "$k" $?
    shift 2
  done
}
m_commit() {
  if [ -d "$2" ]; then rm -f "$1"; T=; return 49; fi
  if [ -e "$2" ] || [ -L "$2" ]; then now=$(m_sum "$2") || now=unreadable; else now=absent; fi
  if [ "$now" != "$3" ]; then rm -f "$1"; T=; return 45; fi
  if [ "$4" != - ]; then chmod "$4" "$1" || { rm -f "$1"; T=; return 75; }; fi
  mv -f "$1" "$2" || { rm -f "$1"; T=; return 75; }
  T=
  m_sum "$2"
}
m_over() {
  now=$(m_sum "$2") || now=unreadable
  if [ "$now" != "$3" ]; then return 45; fi
  B=$(mktemp 2>/dev/null) && cat "$2" > "$B" || { rm -f "$B"; B=; return 74; }
  O=$2
  printf '%s\n' "$4"
  if [ "$1" -gt 0 ]; then m_take "$1" > "$2"; else true > "$2"; fi
  if [ "$(wc -c < "$2")" -ne "$1" ]; then cat "$B" > "$2"; O=; rm -f "$B"; B=; exit 97; fi
  O=; rm -f "$B"; B=
  m_sum "$2"
}
m_loop() {
  printf '%s\n' "$1"; printf '%s\n' "$1" >&2
  m_beat "$2" </dev/null &
  b=$!
  while IFS= read -r req; do
    case $req in
      "$K "*) eval "@{req#"$K "}" ;;
      *) exit 98 ;;
    esac
  done
}
`.replaceAll('@{', '$' + '{')

export function remotePrelude(token: string, ready: string, beatSeconds: number): string {
  return `K=${token}\n${PRELUDE}m_loop ${ready} ${beatSeconds}\n`
}

export function remoteQuote(text: string): string {
  return text
    .split('\n')
    .map(part => `'${part.replaceAll("'", "'\\''")}'`)
    .join('"$N"')
}
