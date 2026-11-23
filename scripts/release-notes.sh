#!/usr/bin/env bash
# GitHub Releases の本文（Markdown）を標準出力に出す。
#
#   scripts/release-notes.sh <タグ> [イメージの digest]
#
# - 変更点: 前の v* タグ（無ければ最初のコミット）から <タグ> までのコミットを古い順に並べる。
#   件名を見出しに、本文の箇条書きをその下に置く（件名は日本語の一行、本文は箇条書き、という約束に合わせている）。
# - 末尾に GHCR のイメージの案内（docker pull と起動コマンド、パッケージのページ、digest）。
#   digest は第 2 引数か環境変数 RELEASE_DIGEST。どちらも無ければその行を省く。
# - イメージの持ち主は環境変数 GITHUB_REPOSITORY（owner/name、Actions が設定する）から。無ければ yosiopp/kadrokreo。
set -euo pipefail

if [ $# -lt 1 ] || [ -z "$1" ]; then
  echo "使い方: $0 <タグ> [イメージの digest]" >&2
  exit 2
fi

tag=$1
digest=${2:-${RELEASE_DIGEST:-}}
repo=${GITHUB_REPOSITORY:-yosiopp/kadrokreo}
owner=$(printf '%s' "${repo%%/*}" | tr '[:upper:]' '[:lower:]')
image="ghcr.io/${owner}/kadrokreo"
version=${tag#v}

if ! git rev-parse -q --verify "${tag}^{commit}" >/dev/null; then
  echo "タグが見つかりません: $tag" >&2
  exit 1
fi

# 前の v* タグ。<タグ> が最初のコミットなら <タグ>^ が無いので空になる
prev=$(git describe --tags --abbrev=0 --match 'v*' "${tag}^" 2>/dev/null || true)
if [ -n "$prev" ]; then
  range="${prev}..${tag}"
else
  range="$tag"
fi

echo "## 変更点"
echo
if [ -n "$prev" ]; then
  echo "${prev} からの変更。"
else
  echo "最初のリリース。"
fi

# コミットごとに: 件名 → 見出し、本文 → 箇条書き（"- " で始まる行と、その字下げした続きの行）だけを残す
git log --reverse --no-merges --format='%x1e%s%n%b' "$range" |
  awk '
    BEGIN { RS = "\036" }
    NF == 0 { next }
    {
      n = split($0, lines, "\n")
      printf "\n### %s\n", lines[1]
      started = 0
      for (i = 2; i <= n; i++) {
        line = lines[i]
        if (line ~ /^- /) {
          if (!started) { printf "\n"; started = 1 }
          print line
        } else if (started && line ~ /^[ \t]+[^ \t]/) {
          print line
        }
      }
    }
  '

cat <<EOF

## Docker イメージ

GitHub Container Registry で公開している（[パッケージのページ](https://github.com/${repo}/pkgs/container/kadrokreo)）。

\`\`\`sh
docker pull ${image}:${version}

docker run --rm -p 8080:80 ${image}:${version}            # viewer モード
docker run --rm -p 8080:80 ${image}:${version} --editor   # editor モード

# kdr コマンド
docker run --rm -i -v "\$PWD:/work" --user "\$(id -u):\$(id -g)" ${image}:${version} kdr --help
\`\`\`

http://localhost:8080 を開く。
EOF

if [ -n "$digest" ]; then
  echo
  echo "イメージの digest: \`${image}@${digest}\`"
fi
