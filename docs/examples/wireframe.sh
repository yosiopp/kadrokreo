#!/bin/sh
# kdr コマンドで、スマホ画面（375×812）のワイヤーフレームを組み立てる例。
#   sh docs/examples/wireframe.sh [出力.kdr]     （省略すると wireframe.kdr）
# 画面は上から ステータスバー・ヘッダー・本文・タブバー。どれもオートレイアウトで並べ、本文は余った高さいっぱいに伸ばす。
# リストの行はコンポーネントにして、インスタンスごとに文言だけを変えている。
# kdr が PATH になければ（npm link していなければ）、リポジトリの cli/kadrokreo.ts を使う。
set -e
OUT=${1:-wireframe.kdr}
if command -v kdr >/dev/null 2>&1; then
  KDR=kdr
else
  KDR="$(cd "$(dirname "$0")/../.." && pwd)/cli/kadrokreo.ts"
fi

# 1. 画面の枠と、上から順に並べる 5 つの区画
"$KDR" new "スマホ ワイヤーフレーム" \
  + add frame --name Screen --id screen --width 375 --height 812 fill=#ffffff \
  + auto-layout screen direction=vertical gap=0 padding=0 widthMode=fixed heightMode=fixed \
  + add frame --parent screen --name StatusBar --id status --height 44 fill=#e5e5e5 \
  + add frame --parent screen --name Header --id header fill=#ffffff \
  + add frame --parent screen --name Content --id content fill=#ffffff \
  + add frame --parent screen --name TabBar --id tabbar fill=#e5e5e5 \
  + layout-fill width status header content tabbar \
  + layout-fill height content \
  -o "$OUT"

# 2. ヘッダー: 戻る・タイトル・アイコン
"$KDR" -f "$OUT" -w \
  add text --parent header --name Back --text "‹ 戻る" fontSize=16 \
  + add text --parent header --name Title --text "タイトル" fontSize=17 fontWeight=700 \
  + add rect --parent header --name MenuIcon --width 24 --height 24 fill=#cccccc \
  + auto-layout header direction=horizontal padding=16 align=center justify=space-between

# 3. 本文: 画像の置き場所・見出し・説明文
"$KDR" -f "$OUT" -w \
  add rect --parent content --name Hero --height 180 fill=#d9d9d9 cornerRadius=8 \
  + add text --parent content --name Heading --text "見出しが入ります" fontSize=22 fontWeight=700 \
  + add text --parent content --name Body --width 343 --text "説明文が入ります。2 行から 3 行くらいの文章を想定しています。" fontSize=14 fill=#666666 lineHeight=1.5 \
  + auto-layout content direction=vertical gap=12 padding=16 \
  + layout-fill width Hero Body

# 4. リストの 1 行をコンポーネントにして、インスタンスを 3 つ並べる
"$KDR" -f "$OUT" -w \
  add frame --parent content --name ListItem --id item fill=#f2f2f2 cornerRadius=8 \
  + add ellipse --parent item --name Avatar --width 40 --height 40 fill=#cccccc \
  + add text --parent item --name Label --text "リストの項目 1" fontSize=15 \
  + auto-layout item direction=horizontal gap=12 padding=12 align=center \
  + layout-fill width item \
  + component item \
  + instance ListItem --parent content --id item2 + set item2/Label text="リストの項目 2" \
  + instance ListItem --parent content --id item3 + set item3/Label text="リストの項目 3" \
  + layout-fill width item2 item3

# 5. ボタンとタブバー
"$KDR" -f "$OUT" -w \
  add frame --parent content --name Button --id button fill=#333333 cornerRadius=8 \
  + add text --parent button --name ButtonLabel --text "次へ" fontSize=16 fontWeight=700 fill=#ffffff \
  + auto-layout button direction=horizontal padding=14 justify=center \
  + layout-fill width button \
  + add rect --parent tabbar --name Tab1 --width 28 --height 28 fill=#999999 \
  + add rect --parent tabbar --name Tab2 --width 28 --height 28 fill=#cccccc \
  + add rect --parent tabbar --name Tab3 --width 28 --height 28 fill=#cccccc \
  + add rect --parent tabbar --name Tab4 --width 28 --height 28 fill=#cccccc \
  + auto-layout tabbar direction=horizontal paddingTop=12 paddingBottom=24 paddingLeft=40 paddingRight=40 justify=space-between


"$KDR" -f "$OUT" ls
