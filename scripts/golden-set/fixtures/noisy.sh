#!/bin/sh
i=1
while [ "$i" -le 60000 ]; do
  echo "noise line $i"
  i=$((i + 1))
done
