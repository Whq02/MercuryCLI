#!/usr/bin/env bash
project_store_dir() {
  local root="$1" name="$2"
  printf '%s' "$root/.mercury/$name"
}
