#!/bin/sh
# 既定は viewer。--editor を付けて起動したときだけ editor のビルドを配信する。
set -eu

mode=viewer
for arg in "$@"; do
  case "$arg" in
    --editor) mode=editor ;;
    --viewer) mode=viewer ;;
    *)
      echo "kadrokreo: unknown option: $arg" >&2
      echo "usage: docker run -p 8080:80 kadrokreo [--editor]" >&2
      exit 64
      ;;
  esac
done

ln -sfn "/srv/kadrokreo/$mode" /srv/kadrokreo/current
echo "kadrokreo: serving $mode mode"
exec nginx -g 'daemon off;'
