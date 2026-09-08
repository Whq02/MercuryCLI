#!/usr/bin/env bash
run_proof() {
  local proof="${1:?proof path required}" started=$SECONDS code
  shift
  if "$@"; then code=0; else code=$?; fi
  case "$proof" in
    */scripts/*) proof="scripts/${proof##*/scripts/}" ;;
    ./*) proof="${proof#./}" ;;
  esac
  printf '── %s  %ss rc=%s\n' "$proof" "$((SECONDS - started))" "$code"
  return "$code"
}
