# コマンドライン（kdr コマンド）

[ユーザーズガイド](README.md) の一部。

`kdr` は、kdr ファイルを調べたり編集したりするコマンドライン（長い名前の `kadrokreo` でも動く）。自動化やエージェントから kdr を組み立てる・書き換えるためのもの。
Docker のイメージから使う（下の「[Docker で使う](#docker-で使う)」）か、リポジトリを手元に置いて Node 24 以降で動かす（`npm install` と `npm link` で `kdr` が PATH に入る。
`npm link` をしなくても `./cli/kadrokreo.ts` で同じように動く）。

## 書き方

```sh
npm link        # kdr と kadrokreo を PATH に置く（npm unlink -g kadrokreo で外す）

kdr [-f 入力.kdr] [-o 出力.kdr | -w] コマンド 引数… [+ コマンド 引数…]…
```

- `+` だけの引数でコマンドを区切ると、1 回の実行で左から順に実行する
- 入力は `-f`（省略すると標準入力）、先頭が `new` なら新しいドキュメント
- 出力は `-o`、`-w` なら入力のファイルへ上書き。どちらもなく、ドキュメントを変えたときは kdr を標準出力へ出すので、パイプでつなげられる
- `ls` などの文字の出力は標準出力へ出る（kdr と同時に標準出力へは出せないので、そのときは `-o` を指定する）
- ノードは id、レイヤー名、`親/子` の道筋（名前か id を `/` でつなぐ）、`@`（直前に作ったノード）で指す

## 例

```sh
# 新しく作る（+ でつなぐ）
kdr new Demo \
  + add frame --name Card --id card --width 320 --height 200 fill=#f5f5ff cornerRadius=12 \
  + add frame --name Button --id btn --parent card fill=#5b4cf5 cornerRadius=8 \
  + add text --parent btn --name Label --text OK fill=#ffffff \
  + auto-layout btn padding=12 + component btn \
  -o demo.kdr

# パイプでつなぐ。インスタンスの中身を変えると、editor と同じく上書きとして覚える
kdr -f demo.kdr instance Button --id btn2 --parent card --x 120 \
  | kdr set btn2/Label text=Cancel -o demo2.kdr

# 調べる
kdr -f demo2.kdr info + ls
kdr -f demo2.kdr css btn2
kdr -f demo2.kdr html card --standalone > card.html
kdr -f demo2.kdr html card --format tailwind   # React（Tailwind）の JSX。react / css-modules / vue も

# PNG に書き出す（viewer の PNG 書き出しと同じ絵・同じファイル名）
kdr -f demo2.kdr png                       # ページ全体 → 「Demo - Page 1.png」
kdr -f demo2.kdr png Card --scale 2        # フレーム（ノード）1 つを 2 倍で → 「Card@2x.png」
kdr -f demo2.kdr png btn btn2 --each --to out   # ノードごとに out/ へ
kdr -f demo2.kdr png Card --to - > card.png     # 標準出力へ

# SVG に書き出す（viewer の SVG 書き出しと同じもの。取り込みの svg とは逆向き）
kdr -f demo2.kdr svg-out                   # ページ全体 → 「Demo - Page 1.svg」
kdr -f demo2.kdr svg-out Card --to card.svg
kdr -f demo2.kdr svg-out Card --no-ids --background '#ffffff' --to -   # id なし・白い背景で標準出力へ

# 上書き保存
kdr -f demo2.kdr -w set Card fill=#ffffff

# グラデーション（3 色、真ん中の位置は 30%、塗りの不透明度 80%）と、バリアントのプロパティ
kdr -f demo2.kdr -w gradient linear Card --colors '#5b4cf5,#a99fff@30%,#ffffff' --angle 90 --opacity 0.8
kdr -f demo2.kdr -w gradient Card --stop '1=#ff000080'   # 2 番目の色だけを半透明の赤に（種類と向きはそのまま）
kdr -f demo2.kdr -w variant-add Button --id big 種類=大 + variant-prop-add big サイズ M + variant-prop-rename big 種類 スタイル
kdr -f demo2.kdr -w variant-prop-order big サイズ 0 + variant-value-order big スタイル 大 0   # サイズを先頭のプロパティに、値「大」を先頭に
```

## コマンドの一覧

| コマンド | 内容 |
| --- | --- |
| `new [名前]` | 新しいドキュメント（先頭にだけ置ける） |
| `info` / `ls [ノード] [--all] [--json]` / `get ノード [項目]` / `find 文字列` / `bounds ノード` | 調べる（`get パス d` は形を SVG の path の d で出す） |
| `css ノード` / `html ノード [--standalone]` / `json [--pretty]` / `components` | viewer のインスペクトと同じ CSS・HTML、kdr の `document.json` の中身、コンポーネントの一覧。`css` と `html` は `--format html\|react\|css-modules\|tailwind\|vue` で viewer のコードの形式と同じものを出す |
| `page ページ` / `page-add 名前` / `page-rename 名前` / `page-rm [ページ]` / `doc-name 名前` | ページとドキュメント |
| `font-add 書体ファイル [--family 書体名]` / `font-rm 書体名 [--weight 太さ] [--italic]` | 書体ファイル（TTF / OTF / WOFF）を kdr に埋め込む・外す。書体名・太さ・斜体はファイルから読む（`--family` で書体名を変えられる）。テキストの `fontFamily` に書体名を書くと、その書体で描かれる（`png` も）。再配布できる書体だけを入れる |
| `add 種類 …` | `rect` `ellipse` `frame` `text`（`--text`）`line`（`--from x,y --to x,y`）`path`（`--points "x,y …" [--closed]` か、曲線を含めるなら SVG の path の `--d "M0 0 C…"`。`M` のまとまりが複数なら穴のあるパス）`image`（`--src 画像`。PNG・JPEG・WebP・GIF、32MB・6,400 万画素まで） |
| `set ノード… 名前=値…` | 設定を変える（`fill=#ff0000`、`shadow.blur=4`、`layout.gap=8`、`sizing.width=fill`、`maxWidth=320`、`constraints.horizontal=end`、`fill=null` で外す）。`fill` / `stroke` / `shadow` は、単色の塗り・線と最初の影の略記（`shadow.spread=4` で影の広がり）。`blur=8` / `backgroundBlur=8` でレイヤー・背景のぼかし（`null` で外す）、`blendMode=multiply` でノードの描画モード。`cornerRadius=8,8,0,0` で角丸を 4 隅ばらばらに（左上・右上・右下・左下）。パスは `radius=8` で全部の輪郭（穴など 2 つ目以降も）の頂点の角を丸める（頂点ごとなら `radius=8,0,8` と、`get ノード d` の順の通し番号で並べる）。特定の輪郭だけなら `radius.N=8`（`N` は 0 から数えた輪郭の番号で、0 が最初の輪郭。`radius.1=4,0,4,0` のように頂点ごとも可）。破線は `dash=4,2`（線の長さ・間隔。`dash=null` で実線）、破線のずれは `dashOffset=2`、線の角の形は `join=round`（`miter` `round` `bevel`）。端の形は `endCap=arrow`（`none` `round` `square` `arrow` `circle` `diamond`）、印の大きさは `capSize=16`。配列は `fills=[…]` と JSON で書くか、`fills.0.color=#ff0000` のように番号でつなぐ |
| `gradient [linear\|radial\|conic] ノード… [--colors 色,色@50%,色…] [--stop N=色[@位置],…] [--angle 度] [--from x,y --to x,y] [--center x,y] [--radius r\|rx,ry] [--focus fx,fy] [--opacity 0〜1] [--blend 描画モード] [--hidden] [--stroke] [--index N \| --add]` | グラデーションの塗りにする（3 色以上、位置は 0〜1 か %。`#ff000000` のような `#rrggbbaa`・`#rgba` の色は最後の桁が色ごとの透明度）。直線は `--angle` か始点・終点（`--from` / `--to`）、円形の `--angle` は楕円を回す角度、`--focus` は焦点（中心からのずれを半径に対する割合で）、角度（conic）は `--center` と `--angle`（最初の色の向き）。`--blend multiply` で塗りの描画モード。ふつうはいちばん上の塗りを置き換え、`--index` で何番目か（0 が一番下）、`--add` で上に重ねる。`--stroke` なら線。`--hidden` でその塗りを隠す。`--colors` を省くと今の色のまま種類や向きだけ変える。`--stop 1=#ff0000` は N 番目（0 が最初、-1 が最後）の色だけを変える（`0=@20%` なら位置だけ。カンマで区切っていくつでも）。種類を省くと今のグラデーションの種類のまま変える。塗り・影を隠すだけなら `set ノード fills.0.visible=false`、内側の影は `set ノード shadow.type=inner-shadow` |
| `rm` / `mv (--parent フレーム \| --root)` / `order front\|back\|forward\|backward` / `dup` | 削除、親の付け替え、重なり順、複製 |
| `boolean union\|subtract\|intersect\|exclude ノード… [--keep [--strokes]]` / `flatten ノード…` | ブーリアン演算（合体・差し引き・交差・除外）。矩形・楕円・パスの塗りの形にかけ、最も背面のものを引き継いだ 1 つのパス（`fillRule=evenodd`）にする。差し引きは最も背面のものから残りを引く。`--keep` なら元の図形を子に残すブーリアン演算のノードにまとめる（演算は `set ノード booleanOperation=intersect` で変えられる）。`--strokes` を付けると元の図形の線の外形も演算に含める（`set ノード booleanIncludeStrokes=true` でも変えられる）。`flatten` はそのノードを結果のパスに焼き込む |
| `outline-stroke ノード…` | 線の輪郭化（線の形を線の色で塗るパスにする。塗りのある図形は残して手前に置く） |
| `join ノード…` / `split パス…` / `mask ノード… [--name 名前] [--type vector\|alpha\|luminance]` | パスの結合（矩形・楕円・パスを 1 つのパスの輪郭に）と分割（輪郭ごとのパスに）、マスクとして使う（矩形・楕円・パス・テキスト・画像・フレーム。いくつもならフレームにまとめる。どれもマスクならやめる。`--type` は形・不透明度・明るさのマスク。`set ノード isMask=true maskType=luminance` でも変えられる） |
| `align left\|center\|right\|top\|middle\|bottom ノード…` / `distribute horizontal\|vertical ノード…` / `rotate 度 ノード… [--each \| --pivot x,y]` / `flip horizontal\|vertical ノード…` | 整列（1 つなら親に揃える）、等間隔、回転（いまの角度に足す。軸はふつう全体の中心）、反転（全体の中心で裏返す。インスタンスは中身の配置も映す） |
| `auto-layout フレーム [--off] [direction=… gap=… padding=… wrap=true crossGap=… alignContent=space-between sizing.width=fixed]` / `wrap ノード…` / `layout-fill width\|height ノード…` | オートレイアウト（`wrap=true` は折り返し。`wrap` コマンドはまとめる操作で別物） |
| `component フレーム` / `detach フレーム` / `instance 元 [--parent フレーム]` / `swap インスタンス 元` | コンポーネント（`swap` は元の差し替え。インスタンスの中の入れ子のインスタンスも） |
| `override-push ノード…` / `override-reset ノード…` | インスタンスの上書きを元に反映する・捨てて元に戻す |
| `variant-add 元 [プロパティ=値…]` / `variant インスタンス… プロパティ=値…` | バリアントを増やす・インスタンスのバリアントを選ぶ（プロパティ名は日本語でもよい） |
| `variant-prop-add まとまり 名前 [値]` / `variant-prop-rename まとまり 名前 新しい名前` / `variant-prop-rm まとまり 名前` / `variant-value-rename まとまり プロパティ 値 新しい値` / `variant-prop-order まとまり 名前 位置` / `variant-value-order まとまり プロパティ 値 位置` | バリアントのプロパティを足す・名前を変える・消す、値の名前を変える、プロパティ・値を並べ替える（位置は 0 が先頭。値の順はまとまりの中のバリアントの並び順なので、値を並べ替えるとバリアントの並びが変わる。すべてのバリアントの名前を書き換える。まとまりの代わりに中のバリアントを指してもよい） |
| `describe 元\|まとまり 説明文` / `prop-add 元 text\|boolean\|instance ノード… [--name 名前]` / `prop インスタンス… 名前=値…` | コンポーネント（またはバリアントのまとまり）の説明文、プロパティを作って元の中のノードに結ぶ、インスタンスのプロパティの値を決める |
| `prop-rename 元 名前 新しい名前` / `prop-order 元 名前 位置` / `prop-prefer 元 名前 [候補の元…]` / `prop-rm 元 名前` / `prop-align まとまり` | 元のプロパティの名前を変える・並べ替える（0 が先頭）・差し替えの候補を決める・消す（元がバリアントなら、まとまりのすべてのバリアントで揃える）、揃っていないバリアントのプロパティを一度に揃える |
| `svg ファイル.svg [--parent フレーム] [--x N --y N]` | SVG を図形のノードに変換して置く（表せずに落としたものは標準エラーに出る） |
| `png [ノード…] [--scale 2] [--to ファイル.png\|-] [--each] [--background 色]` | PNG に書き出す。ノードなしならページ全体、ノード（いくつでも）ならそれらを囲む範囲。`--to` を省くと viewer と同じ名前で今のディレクトリへ。`--each` はノードごとのファイル（`--to` はディレクトリ）。`--background` は背景の色を敷く（既定は透明）。ドキュメントは変えない |
| `svg-out [ノード…] [--to ファイル.svg\|-] [--each] [--no-ids] [--background 色]` | SVG に書き出す。範囲・ファイル名・`--to`・`--each` は `png` と同じ（倍率はない）。`--no-ids` はレイヤー名の id を付けない、`--background` は背景の色を敷く。テキストの折り返しは見積もりで、基線は `png` と同じ描画のライブラリで測った書体の高さで決める（ライブラリが無ければ見積もる）。ドキュメントは変えない |


すべてのコマンドの説明は `kdr --help`、1 つだけなら `kdr help add`（`kdr add --help` も同じ）で、例も出る。
`kdr docs` は、呼び方・ノードの指定・出力の形・終了コード・すべてのコマンドと例をまとめたリファレンスを Markdown で出す（[AI エージェントから使う](#ai-エージェントから使う)）。

## 注意

- 変更のたびに editor と同じ後始末（自動で並べ直す・インスタンスを元に合わせる・インスタンスへの変更を上書きとして覚える）をし、
  kdr として読み込める形かを確かめる。壊れた値（`fill=red` など）はエラーにして、何も書き出さない
- テキストの大きさ（`ls` の幅など）は、環境で結果が変わらないよう見積もる（英数字はブラウザの sans-serif と同じ字幅の表、全角は 1 文字 1em）。editor で文字を変えれば測り直される
- `png` は viewer / editor と同じ描画を Node 用の Canvas（[`@napi-rs/canvas`](https://www.npmjs.com/package/@napi-rs/canvas)）で行う。
  任意の依存なので、入っていない環境（`npm install --omit=optional` など）では `png` だけがエラーになる。Docker のイメージには入っている。
  文字は手元の書体で描く（macOS は Helvetica とヒラギノ、Docker のイメージは Liberation Sans と Noto Sans CJK）ので、ブラウザで書き出したものと文字の細部が少し違うことがある。
  kdr に埋め込んだ書体（`font-add`）は、手元になくてもその書体で描く
- `ls` などのテキストの大きさの見積もりは、埋め込んだ書体でも同じ見積もりを使う（editor で文字を変えれば、その書体で測り直される）

## Docker で使う

イメージ（`ghcr.io/yosiopp/kadrokreo`。手元でビルドした `kadrokreo` でもよい）の最初の引数を `kdr` にすると、kdr コマンドとして動く。手元のディレクトリを `/work` につなぐと、ファイルの相対パスはそこから数える。

```sh
# 手元のファイルを読み書きする（--user を付けると、書き出したファイルの持ち主が自分になる）
docker run --rm -v "$PWD:/work" --user "$(id -u):$(id -g)" ghcr.io/yosiopp/kadrokreo kdr new Demo + add rect --name Box -o demo.kdr
docker run --rm -v "$PWD:/work" --user "$(id -u):$(id -g)" ghcr.io/yosiopp/kadrokreo kdr -f demo.kdr ls

# パイプでつなぐときは -i を付ける（標準入力を渡すため）。-t は付けない（kdr を端末へは出さない）
docker run --rm -i ghcr.io/yosiopp/kadrokreo kdr new | docker run --rm -i ghcr.io/yosiopp/kadrokreo kdr add rect --name Box > demo.kdr

# PNG も書き出せる（イメージに描画のライブラリと日本語の書体が入っている）
docker run --rm -v "$PWD:/work" --user "$(id -u):$(id -g)" ghcr.io/yosiopp/kadrokreo kdr -f demo.kdr png --scale 2
docker run --rm -i ghcr.io/yosiopp/kadrokreo kdr -f - png --to - < demo.kdr > page.png
```

毎回書くのが長ければ、シェルの関数にしておくと手元の `kdr` と同じように使える。

```sh
kdr() { docker run --rm -i -v "$PWD:/work" --user "$(id -u):$(id -g)" ghcr.io/yosiopp/kadrokreo kdr "$@"; }
```

- 終了コード（0 成功・1 エラー・2 使い方の誤り）とエラーの表示は、そのまま `docker run` の結果になる
- `/work` の外（親ディレクトリや絶対パス）のファイルは、コンテナからは見えない。必要なら `-v` で別につなぐ
- コンテナの中では `kdr`（と `kadrokreo`）が PATH にあるので、`--entrypoint sh` で入ってスクリプトから呼ぶこともできる

## AI エージェントから使う

Claude などの AI エージェントに kdr ファイルを作らせる・直させるときも、Docker のイメージの kdr コマンドを使う。
エージェントが自分で読めるように、イメージには使い方の文書が入っている。

```sh
docker run --rm ghcr.io/yosiopp/kadrokreo kdr docs        # 全体のリファレンス（Markdown）
docker run --rm ghcr.io/yosiopp/kadrokreo kdr help set    # 1 つのコマンドの説明と例
```

`kdr docs` には、Docker 越しの呼び方（`-i` は付ける・`-t` は付けない・パスは `/work` からの相対・`--user` で持ち主を合わせる）、
ノードの指定、`+` とパイプ、JSON で出せるコマンド、終了コードとエラーの出方、作る → 調べる → 変える → PNG / SVG で確かめる流れ、
すべてのコマンドと例が載っている。

### skill（プラグイン）を入れる

このリポジトリは Claude Code のプラグインのマーケットプレイスになっていて、kdr の skill（[`plugins/kdr/skills/kdr/SKILL.md`](../../plugins/kdr/skills/kdr/SKILL.md)）を入れられる。
入れておくと、kdr ファイルを扱う頼みごとのときに、エージェントが Docker 越しの呼び方に従い、`kdr docs` を読んでから作業する。
```sh
claude plugin marketplace add yosiopp/kadrokreo
claude plugin install kdr@kadrokreo
```

Claude Code の中なら `/plugin marketplace add yosiopp/kadrokreo` の後に `/plugin install kdr@kadrokreo`
（新しい版では `/plugin install kdr --marketplace yosiopp/kadrokreo` の 1 行でもよい）。

ほかのエージェントでは、`plugins/kdr/skills/kdr/` のフォルダ（`SKILL.md` だけ）を、そのエージェントが skill を読む場所へ写す（SKILL.md は Agent Skills の形式）。

### プロジェクトの AGENTS.md / CLAUDE.md に書く

skill を入れない場合や、イメージ名を変えている場合は、自分のプロジェクトの `AGENTS.md` か `CLAUDE.md` に次のように書いておく（イメージ名は使っているものに直す）。

```markdown
## kdr ファイル（デザイン）

- `.kdr` は kadrokreo のデザインファイル。中を直接書き換えず、Docker の kdr コマンドで扱う:
  `docker run --rm -i -v "$PWD:/work" --user "$(id -u):$(id -g)" ghcr.io/yosiopp/kadrokreo kdr …`（`-t` は付けない。パスは今のディレクトリからの相対）
- 使う前に `docker run --rm ghcr.io/yosiopp/kadrokreo kdr docs` を読む。1 つのコマンドは `kdr help コマンド`
- 変えたら `kdr -f ファイル.kdr png ノード --to 確認.png` で書き出して、見た目を確かめる
```

### 短い名前で呼べるようにする

毎回 `docker run …` と書かずに済むよう、シェルにラッパーを置いておくと、人もエージェントも `kdr …` と書ける。

```sh
# ~/.bashrc や ~/.zshrc に（関数なので、パイプでも引数の引用でもそのまま動く）
kdr() { docker run --rm -i -v "$PWD:/work" --user "$(id -u):$(id -g)" ghcr.io/yosiopp/kadrokreo kdr "$@"; }

# エイリアスでもよい（対話シェルだけで効く）
alias kdr='docker run --rm -i -v "$PWD:/work" --user "$(id -u):$(id -g)" ghcr.io/yosiopp/kadrokreo kdr'
```

エージェントのシェルは対話シェルでないことが多く、エイリアスや `~/.zshrc` の関数が効かないことがある。
そのときは PATH の通った場所に小さなスクリプトを置く。

```sh
#!/bin/sh
# 例: ~/.local/bin/kdr（chmod +x する）
exec docker run --rm -i -v "$PWD:/work" --user "$(id -u):$(id -g)" ghcr.io/yosiopp/kadrokreo kdr "$@"
```

## 例: ワイヤーフレームを組み立てる

まとまった例として、スマホ画面（375×812）のワイヤーフレームを組み立てるスクリプトを [`docs/examples/wireframe.sh`](../examples/wireframe.sh) に置いている
（リポジトリの置き場所で `sh docs/examples/wireframe.sh 出力.kdr`。`kdr` が PATH になければ、リポジトリの `cli/kadrokreo.ts` を使う）。
オートレイアウトで区画を並べ、リストの行をコンポーネントにしてインスタンスで増やす、という組み立て方の見本になっている。
