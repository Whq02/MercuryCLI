#!/bin/sh
# The proof suite's hook: records the MERCURY_ env it received into the data folder.
if [ -n "$MERCURY_EXTENSION_DATA" ]; then
  mkdir -p "$MERCURY_EXTENSION_DATA"
  {
    echo "ROOT=$MERCURY_EXTENSION_ROOT"
    echo "DATA=$MERCURY_EXTENSION_DATA"
    env | grep '^MERCURY_' | sort || true
    echo "--"
  } >> "$MERCURY_EXTENSION_DATA/hook.log"
fi
exit 0
