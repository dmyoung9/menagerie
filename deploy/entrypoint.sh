#!/bin/sh
set -eu
if [ ! -w /data ]; then
  echo 'Menagerie needs a writable /data mount owned by the selected container UID/GID.' >&2
  exit 1
fi
exec menagerie serve --port "$MENAGERIE_PORT" --gateway-port "$MENAGERIE_GATEWAY_PORT" "$@"
