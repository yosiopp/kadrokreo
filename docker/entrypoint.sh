#!/bin/sh
# 既定は viewer。--editor を付けて起動したときだけ editor のビルドを配信する。
# 最初の引数が kdr（または kadrokreo）なら、配信はせずに kdr コマンドを実行する。
#   docker run --rm -i -v "$PWD:/work" kadrokreo kdr -f design.kdr ls
set -eu

case "${1:-}" in
  kdr | kadrokreo)
    shift
    # ファイルの相対パスは /work（-v でつないだ手元のディレクトリ）から数える
    cd /work
    exec kdr "$@"
    ;;
esac

mode=viewer
for arg in "$@"; do
  case "$arg" in
    --editor) mode=editor ;;
    --viewer) mode=viewer ;;
    *)
      echo "kadrokreo: unknown option: $arg" >&2
      echo "usage: docker run -p 8080:80 kadrokreo [--editor]" >&2
      echo "       docker run --rm -i -v \"\$PWD:/work\" kadrokreo kdr [kdr の引数…]" >&2
      exit 64
      ;;
  esac
done

ln -sfn "/srv/kadrokreo/$mode" /srv/kadrokreo/current
echo "kadrokreo: serving $mode mode"
exec nginx -g 'daemon off;'
