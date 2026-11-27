import { KDR_VERSION } from '../src/document/kdr.ts'
import { UsageError } from './args.ts'
import { COMMANDS, type Command } from './commands.ts'
import { CHECKS } from './commands/lint.ts'
import { EXAMPLES, EXAMPLE_DOCUMENT, EXAMPLE_MARKUP } from './examples.ts'

// kdr --help（全体）、kdr help コマンド / kdr コマンド --help（1 つ）、kdr docs（エージェント向けの全体のリファレンス、Markdown）。
// どれもコマンドの定義（commands/ の usage・summary）と examples.ts から作るので、食い違わない。

const GROUPS: [string, Command['kind'][]][] = [
  ['作る', ['source']],
  ['調べる（標準出力へ）', ['query']],
  ['書き出す（ファイルへ）', ['export']],
  ['ページ', ['nav']],
  ['変える', ['edit']],
]

function examplesOf(name: string): readonly string[] {
  return EXAMPLES[name] ?? []
}

/** kdr help コマンド。名前を省くと全体のヘルプ */
export function help(name?: string): string {
  if (name === undefined) return overview()
  if (name === 'help' || name === 'docs' || name === 'mcp') return builtinHelp(name)
  const command = COMMANDS.get(name)
  if (!command) throw new UsageError(`不明なコマンドです: ${name}`)
  const lines = [`kdr ${command.usage}`, '', command.summary, '']
  const examples = examplesOf(name)
  if (examples.length > 0) lines.push('例:', ...examples.map((example) => `  ${example}`), '')
  lines.push(
    '入出力の指定（-f 入力 / -o 出力 / -w 上書き / + でつなぐ）は kdr --help、全体のリファレンスは kdr docs',
  )
  return lines.join('\n') + '\n'
}

function builtinHelp(name: 'help' | 'docs' | 'mcp'): string {
  switch (name) {
    case 'help':
      return 'kdr help [コマンド]\n\nコマンドの説明と例を出す（kdr コマンド --help と同じ）。省くと全体のヘルプ\n'
    case 'docs':
      return 'kdr docs\n\nエージェント向けの全体のリファレンス（Docker 越しの呼び方・ノードの指定・出力の形・終了コード・すべてのコマンドと例）を Markdown で標準出力へ出す\n'
    case 'mcp':
      return (
        'kdr mcp\n\nAI エージェント向けの MCP（Model Context Protocol）のサーバーとして常駐する。標準入出力で JSON-RPC をやり取りし、ネットワークの口は開かない。\n' +
        '道具は open（kdr を開く）・run（コマンドを実行）・png（画像で返す）・save（保存）・help。登録の仕方は kdr docs の「MCP のサーバー」\n'
      )
  }
}

function overview(): string {
  const lines = [
    'kdr — kadrokreo の kdr ファイルをコマンドラインで調べ、編集する（kadrokreo という名前でも動く）',
    '',
    '使い方:',
    '  kdr [-f 入力.kdr] [-o 出力.kdr | -w] コマンド 引数… [+ コマンド 引数…]…',
    '',
    '  -f, --file   入力の kdr（- は標準入力。省略すると標準入力）。先頭のコマンドが new・build なら入力なしで新しく作る',
    '  -o, --out    出力の kdr（- は標準出力）。指定すると変えていなくても書き出す（古い版の更新に使える）',
    '  -w, --write  入力のファイルへ上書きする',
    '  +            コマンドの区切り。左から順に実行する',
    '',
    '  ドキュメントを変えたのに -o も -w もなければ、kdr を標準出力へ出すので、パイプでつなげられる:',
    '    kdr new Demo | kdr add rect --name Box | kdr set Box fill=#ff0000 -o demo.kdr',
    '',
    'ノードの指定: id、レイヤー名、「親/子」の道筋、@（直前に作ったノード）',
    '',
  ]
  for (const [title, kinds] of GROUPS) {
    lines.push(`${title}:`)
    for (const command of COMMANDS.values()) {
      if (!kinds.includes(command.kind)) continue
      lines.push(`  ${command.usage}`, `      ${command.summary}`)
    }
    lines.push('')
  }
  lines.push(
    'kdr help コマンド（または kdr コマンド --help）で、1 つのコマンドの説明と例を出す',
    'kdr docs で、エージェント向けの全体のリファレンスを Markdown で出す',
    'kdr mcp で、AI エージェント向けの MCP のサーバーとして常駐する（標準入出力だけ）',
  )
  return lines.join('\n') + '\n'
}

/** kdr docs。エージェントが読んで kdr を使えるようにするための全体のリファレンス */
export function docs(): string {
  const fence = '```'
  const out: string[] = [
    `# kdr リファレンス（kdr ファイル v${KDR_VERSION}）`,
    '',
    'kdr は、kadrokreo のデザインファイル（`.kdr`。ドキュメントの JSON と画像をまとめた tar.gz）を作る・調べる・編集する・PNG / SVG に書き出すコマンドライン。',
    'この文書は `kdr docs` の出力で、コマンドの定義から作っている。1 つのコマンドだけなら `kdr help コマンド`。',
    '',
    '## Docker 越しに呼ぶ',
    '',
    'kdr は kadrokreo の Docker イメージに入っている。イメージの最初の引数を `kdr` にすると kdr として動く。',
    '',
    `${fence}sh`,
    'docker run --rm -i -v "$PWD:/work" --user "$(id -u):$(id -g)" ghcr.io/yosiopp/kadrokreo kdr -f design.kdr ls',
    fence,
    '',
    '- イメージは公開されている `ghcr.io/yosiopp/kadrokreo`（タグを省くと `latest`。版を固定するなら `:0.1.0` など）。手元でビルドしたもの（`docker build -t kadrokreo .`）なら `kadrokreo` に読み替える',
    '- `-i` は付ける（パイプで kdr を受け渡すため）。`-t` は付けない（端末につながると、kdr や PNG を標準出力へ出すのを拒む）',
    '- `-v "$PWD:/work"` で今のディレクトリを `/work` につなぐ。コンテナの中の作業ディレクトリは `/work` なので、ファイルは**そこからの相対パス**で指す。`/work` の外（親ディレクトリ・ホストの絶対パス）は見えない',
    '- `--user "$(id -u):$(id -g)"` を付けると、書き出したファイルの持ち主が自分になる（付けないと root のファイルになる）',
    '- 入力は `-f ファイル` で渡すのが確実。`-f` も `new` もないと標準入力から kdr を読むので、パイプでないと入力を待ち続けることがある',
    '- 毎回書くのが長ければ、シェルの関数にする: `kdr() { docker run --rm -i -v "$PWD:/work" --user "$(id -u):$(id -g)" ghcr.io/yosiopp/kadrokreo kdr "$@"; }`',
    '- PNG の描画のライブラリ（`@napi-rs/canvas`）と書体（Liberation Sans・Noto Sans CJK）はイメージに入っている。リポジトリから直接動かすときは、任意の依存が入っていないと `png` だけがエラーになる',
    '',
    '以下の例は `kdr …` と書く。Docker なら `kdr` を上の `docker run … ghcr.io/yosiopp/kadrokreo kdr` に読み替える。',
    '',
    '## MCP のサーバー（kdr mcp）',
    '',
    '`kdr mcp` は、MCP（Model Context Protocol）のサーバーとして常駐する。標準入出力で JSON-RPC をやり取りするだけで、ネットワークの口は開かない。コマンドのたびにコンテナを起動せずに済み、開いたドキュメントをメモリに持って編集を重ね、PNG を画像のまま受け取れる。',
    'MCP に対応したクライアントに、次のコマンドで起動するサーバーとして登録する（`-i` は要る。`-t` は付けない）。',
    '',
    `${fence}sh`,
    'docker run --rm -i -v "$PWD:/work" --user "$(id -u):$(id -g)" ghcr.io/yosiopp/kadrokreo kdr mcp',
    fence,
    '',
    'クライアントの設定はシェルを通さずに起動することが多いので、`$PWD` を使うなら `sh -c` で包む（プロジェクトの `.mcp.json` の例）:',
    '',
    `${fence}json`,
    '{ "mcpServers": { "kdr": { "command": "sh", "args": ["-c", "exec docker run --rm -i -v \\"$PWD:/work\\" --user \\"$(id -u):$(id -g)\\" ghcr.io/yosiopp/kadrokreo kdr mcp"] } } }',
    fence,
    '',
    '| 道具 | 引数 | すること |',
    '| --- | --- | --- |',
    '| `open` | `path` | kdr を読み込んで、開いているドキュメントにする（保存していない変更は捨てる） |',
    '| `run` | `args`（文字列の配列）、`stdin`（任意） | この文書のコマンドを、開いているドキュメントに対して実行し、文字の出力を返す。`args` は `kdr` の後ろの引数（例 `["set", "Title", "text=ホーム", "+", "get", "Title"]`）。`new`・`build` で始めると新しく作る。`-f`・`-o`・`-w` は使えない。`stdin` は `build -` / `place -` のマークアップ |',
    '| `png` | `nodes`・`scale`・`background`（どれも任意） | `png` と同じ絵を、ファイルに書かずに画像（`image/png`）で返す |',
    '| `save` | `path`（任意） | kdr に書き出す。省くと開いたファイルへ |',
    '| `help` | `command`（任意） | この文書（省いたとき）か、1 つのコマンドの説明 |',
    '',
    '- 変更はメモリにあり、`save` するまでファイルは変わらない。`run` が途中で失敗したら、その呼び出しの変更はすべて捨てる。いまのページと `@` は呼び出しをまたいで覚える',
    '- パスはサーバーの今のディレクトリ（Docker なら `/work`）からの相対パス。`run` の `png --to`・`svg-out` などのファイルの書き出しも、コマンドラインと同じく使える',
    '- エラーは道具の結果（`isError`）として、コマンドラインと同じ文面で返る',
    '',
    '## 書き方',
    '',
    `${fence}sh`,
    'kdr [-f 入力.kdr] [-o 出力.kdr | -w] コマンド 引数… [+ コマンド 引数…]…',
    fence,
    '',
    '- `-f` 入力の kdr（`-` か省略で標準入力）。先頭のコマンドが `new`・`build` なら入力なしで新しく作る',
    '- `-o` 出力の kdr（`-` は標準出力）、`-w` は入力のファイルへ上書き',
    '- `-o` も `-w` もなく、ドキュメントを変えたときは kdr を標準出力へ出す（パイプで次の kdr へつなげる）。調べるだけのコマンドなら kdr は出さない',
    '- `+` だけの引数でコマンドを区切ると、1 回の実行の中で左から順に実行する。途中で失敗すると何も書き出さない',
    '- オプションは `--名前 値` か `--名前=値`。設定は `名前=値`（`set` など）',
    '- `-f` `-o` `-w` はどの位置に書いてもよい',
    '',
    `${fence}sh`,
    '# + でつなぐ（1 回の実行）',
    'kdr new Demo + add frame --name Card --width 320 --height 200 fill=#ffffff + add text --parent Card --text Hello -o demo.kdr',
    '# パイプでつなぐ（Docker なら各 docker run に -i）',
    'kdr new Demo | kdr add rect --name Box | kdr set Box fill=#ff0000 -o demo.kdr',
    '# 上書きして保存',
    'kdr -f demo.kdr -w set Box cornerRadius=8',
    fence,
    '',
    '## ノードの指定',
    '',
    '- **id**（`ls` や `find` で出る。`add --id` で自分で決めてもよい。英数字と `_` `-`）',
    '- **レイヤー名**（同じ名前が 2 つ以上あるとエラーになり、候補の id を出す）',
    '- **道筋** `親/子`（名前か id を `/` でつなぐ。先頭はどの深さからでもよい。例 `Card/Button/Label`、`btn2/Label`）',
    '- **`@`** 直前のコマンドで作ったノード（`add`・`dup`・`instance`・`wrap`・`join`・`boolean` など。説明に「@ で指せる」とあるもの）',
    '- ページは `page ページ` で切り替える（id・名前・1 から数えた番号）。ほかのコマンドはいまのページだけを扱う',
    '- 座標は親の左上が原点（ページ直下ならページの原点）。単位は px',
    '',
    '確実にするには、作るときに `--id` を付けて、その id で指すのがよい。',
    '',
    '## 出力の形',
    '',
    '- 文字の出力は標準出力へ。kdr と同時に標準出力へは出せないので、変えながら調べるときは `-o` か `-w` を付ける',
    '- JSON で出すもの: `ls --json`（ノードの木。`--all` で全ページ）、`get ノード [項目]`（ノードの設定。項目が文字列ならそのまま）、`json [--pretty]`（ドキュメント全体。kdr の `document.json` と同じ形）',
    '- 表で出すもの: `find`（id・種類・道筋のタブ区切り）、`components`（ページ・id・名前・インスタンスの数のタブ区切り）、`bounds`（`x y width height` の空白区切り）、`ls`（字下げした木。1 行に種類・名前・id・位置と大きさ）、`info`（`名前: 値`）',
    '- コード: `css`・`html`（`--format html|react|css-modules|tailwind|vue`）',
    '- 書き出し: `png` と `svg-out` はファイルへ書き、書いたパスを標準エラーへ知らせる。`--to -` なら標準出力へ（ほかの標準出力への出力とは一緒にできない）',
    '- 集計: `colors`・`text-styles`・`shadows`（viewer の「このページの色・文字・影」と同じ数え方。見えない色・隠れた色は数えない）。1 行に値と使われている数のタブ区切り。`--json` なら値（`color` / 書式の項目 / `shadow`）・`value`（表示用の書き方）・`count`・`nodes`（`{"page": ページの id, "id": ノードの id}` の配列）を持つオブジェクトの配列',
    '- 検査: `lint`（下の「検査（lint）」）。1 行に `id<TAB>検査の名前<TAB>説明`、`--json` は `check`・`page`・`id`・`name`・`message` の配列',
    '- 置き換え: `replace 探す 置き換える` は、置き換えたノードを 1 行に 1 つ（ページ名・id・道筋・件数のタブ区切り）と、合計の行を標準エラーへ知らせる（kdr の出力と一緒に使える）。見つからなければそう知らせて、ドキュメントは変えない',
    '- 違い: `diff 前.kdr 後.kdr`（ほかのコマンドとはつなげない）。1 行に `+`（増えた）`-`（消えた）`~`（変わった）・種類・名前・id、変わったノードは続く行に `項目: 前 → 後`。ノードはページごとに `# ページ名  id` の見出しの下。`--json` なら `different`・`document`・`pages`・`nodes`・`components`・`assets`・`fonts` を持つ JSON（違いが無くても出す）',
    '',
    '## 終了コードとエラー',
    '',
    '- `0` 成功、`1` エラー（ファイルが読めない・kdr が壊れている・値が kdr の決まりに合わない `fill=red` など）、`2` 使い方の誤り（不明なコマンドやオプション、引数の不足、ノードが見つからない・名前があいまい、入出力の組み合わせの誤り）',
    '- `diff` は違いがあれば、`lint` は見つかれば `1`、無ければ `0`。見つけたものと失敗を見分けられるよう、`diff`・`lint` を含む実行の失敗はすべて `2`',
    '- エラーは標準エラーに `kdr: コマンド: 内容` の 1 行で出る。使い方の誤りなら続けて `（使い方は kdr --help）`。エラーのときは何も書き出さない（`-w` でも元のファイルはそのまま）',
    '- 成功しても標準エラーに知らせ（`kdr: PNG を書き出しました: …`、SVG の取り込みで落としたもの）が出ることがある。結果は終了コードで判断する',
    '- 値はコマンドごとに kdr の決まりで確かめるので、壊れた kdr は書き出さない（`fill=red` などはエラー。色は `#rrggbb`）',
    '',
    '## よくある流れ',
    '',
    `${fence}sh`,
    '# 1. 作る（id を決めておくと後で指しやすい）',
    'kdr new App \\',
    '  + add frame --name Screen --id screen --width 375 --height 812 fill=#ffffff \\',
    '  + add frame --name Header --id header --parent screen --width 375 --height 56 fill=#5b4cf5 \\',
    '  + add text --name Title --id title --parent header --x 16 --y 16 --text "ホーム" fill=#ffffff fontSize=20 \\',
    '  -o app.kdr',
    '',
    '# 2. 調べる',
    'kdr -f app.kdr ls            # 木の形で',
    'kdr -f app.kdr ls --json     # JSON で',
    'kdr -f app.kdr get title     # 1 つのノードの設定',
    'kdr -f app.kdr find ホーム    # 名前や文字で探す',
    '',
    '# 3. 変える（-w で上書き）',
    'kdr -f app.kdr -w set title text=設定 + auto-layout header padding=16 align=center',
    'kdr -f app.kdr -w replace ログイン サインイン --all-pages    # 文言をまとめて置き換える',
    '',
    '# 4. 見た目を確かめる',
    'kdr -f app.kdr png screen --to screen.png     # 画像のファイルへ',
    'kdr -f app.kdr svg-out screen --to -          # SVG を標準出力へ（文字なので読める）',
    fence,
    '',
    '- 見た目を確かめたいときは、`png … --to ファイル.png` で書き出して画像を見るか、`svg-out … --to -` の SVG を読む',
    '- 変える前に `ls` か `get` で今の値を確かめ、変えた後にもう一度 `get` で確かめると確実',
    '- 多くの変更は 1 回の実行に `+` でまとめると速い（Docker の起動が 1 回で済む）',
    '- 画面をまるごと組み立てるなら、`add` を並べるより、木をマークアップに書いて `build` に渡すほうが短く、作り直しても id が変わらない（下の「マークアップ」）',
    '- `set` に渡せる項目は、`get ノード` の JSON のキーと同じ。入れ子は `.` でつなぎ（`layout.gap=8`）、配列は番号でつなぐ（`fills.0.color=#ff0000`）。よく使うものには略記がある（`fill=`・`stroke=`・`shadow.blur=`・`blur=`・`dash=`・`dashOffset=`・`join=`・`cornerRadius=8,8,0,0`、大きさの決め方 `width=fill|hug|数値`、行の高さ `lineHeight=24px`、字間 `letterSpacing=0.05em`、フレームの `layout=row|column|grid` と並べ方 `gap=8` `padding="12 40"` `align=center` `justify=space-between` `columns=3` `columnWidth=120`）',
    '',
    '## マークアップ（build・place）',
    '',
    '画面をまるごと組み立てるときは、コマンドを 1 つずつ並べる代わりに、ノードの木を XML のマークアップに書いて `kdr build` に渡す。今の kdr に木の一部を足すなら `kdr place`。',
    '',
    '`design.xml`（全体。最上位は `<kdr>`、その下に `<page>`）:',
    '',
    `${fence}xml`,
    EXAMPLE_MARKUP['design.xml'].trimEnd(),
    fence,
    '',
    '`part.xml`（木の一部。最上位はノードの要素 1 つ）:',
    '',
    `${fence}xml`,
    EXAMPLE_MARKUP['part.xml'].trimEnd(),
    fence,
    '',
    `${fence}sh`,
    'kdr build design.xml -o design.kdr                 # 全体を作る',
    'kdr -f demo.kdr -w place part.xml --parent card    # 今の kdr に、木の一部を足す',
    fence,
    '',
    '- **要素**: `<frame>` `<rect>` `<ellipse>` `<polygon count="頂点の数">` `<star count="先の数" ratio="内側の比">` `<text>` `<image src="…">` `<line from="x,y" to="x,y">` `<path d="M0 0 L…">`（か `points="x,y x,y …" closed="true"`）、`<component>`（コンポーネントの元になるフレーム）、`<component-set>`（バリアントのまとまり）、`<instance of="元の id か名前">`',
    '- **親子と重なり順**: 入れ子が親子、書いた順が重なり順（先に書いたものが背面。自動で並べるフレームでは並ぶ順）。子を持てるのは `<frame>` `<component>` `<component-set>`',
    '- **属性**: `set` の「名前=値」と同じ（`name` `fill` `stroke` `strokeWidth` `cornerRadius` `opacity` `fontSize` `fontWeight` `textAlign` `shadow.blur` `clipContent` …）。書く順は問わない。色は `#rrggbb`',
    '- **書かなかった項目は「なし」**: 塗りなし・線なし・余白 0・間隔 0 から始まる（`add` と違い、灰色の塗りや余白 10 は付かない）。テキストだけは黒・16px の sans-serif',
    '- **並べ方**: `layout="row|column"` でそのフレームの子を自動で並べ、`gap` `padding`（`"16"` `"12 40"` `"12 40 24"` `"1 2 3 4"`。CSS と同じ順）`align="start|center|end"` `justify="start|center|end|space-between"` `wrap="true"` で決める。`layout="grid"` は行と列の 2 次元に並べる（`columns="3"` 列の数、`columnWidth="120"` 列の幅。書かなければ等分、`gap` 列の間隔、`crossGap` 行の間隔、`align` セルの中の縦の揃え）',
    '- **大きさ**: `width` / `height` は、数値（固定）・`fill`（親いっぱいに伸ばす。自動で並べるフレームの子だけ）・`hug`（中身に合わせる。自動で並べるフレームとテキストの幅だけ。省いたときもこれ）。`<rect>` `<ellipse>` と、並べない `<frame>` には大きさを書く。`<polygon>` `<star>` は片方だけ書けば正しい形の縦横比で、省けば幅 100。`<image>` は省くと画像の大きさ（片方だけ書くと縦横比を保つ）。テキストは `width` を書くとその幅で折り返す（高さは書かない）',
    '- **位置**: `x` `y` を書くのは、並べないフレームの子・ページ直下のもの・並びから外したもの（`layoutPositioning="absolute"`）だけ。ほかは並べ直しが決める。`<line>` と `<path>` の座標は親の左上が原点',
    '- **テキスト**: 要素の中身に書く（前後の空白と行ごとの字下げは除く。途中の改行は改行になる）。`<` と `&` は `&lt;` `&amp;`。空白をそのまま残すなら `text="…"` の属性に書く。行の高さは `lineHeight="1.5"`（fontSize に対する倍率）か `"24px"`、字間は `letterSpacing="2"`（px）か `"0.05em"`、装飾は `textDecoration="underline"`（`line-through`）',
    '- **画像**: `src` はマークアップのファイルからの相対パス（PNG・JPEG・WebP・GIF）',
    '- **コンポーネント**: `<instance of="…">` の元は、マークアップの中の `<component>` の `id`、なければ `name` で探す（`place` は、なければ今の kdr の元からも探す）。中身を変えるのは `<override node="レイヤー名" text="…" fill="…" visible="false"/>`（変えられるのは文言・書体の大きさと太さ・塗り・線・表示・画像の `src`）。同じ名前がいくつもあれば `node="親/子"` か、元の側で付けた `id` で指す。入れ子のインスタンスの差し替えは `<override node="…" of="別の元"/>`。`<instance>` 自身に書けるのは `id` `name` `x` `y` `rotation` `visible` `locked` `opacity` `blendMode`、`width="fill"` / `height="fill"`、塗りと線（`fill` `stroke`）で、ほかは元で決まる',
    '- **説明文・プロパティ・バリアント**: 説明文は `<component description="…">`。プロパティは元の中のノードに `prop="名前"`（`<text>` なら文言、`<instance>` なら差し替え）か `prop.visible="名前"`（表示）を書いて結ぶ（同じ名前は結び足す）。インスタンスでの値は `<override prop="名前" value="…"/>`（`prop` コマンドと同じ値）。バリアントは `<component-set name="Button" description="…">` の直下に `<component variant="種類=大, 状態=標準">` を並べ（`name` は書かない）、`<instance of="Button" variant="種類=大">` で選ぶ（書かなかったプロパティは、まとまりの最初のバリアントに近いもの）。差し替えの候補とプロパティの並べ替えは、`+ prop-prefer` `+ prop-order` でつなぐ',
    '- **id**: 省ける。省くと木の道筋（名前と、同じ名前の兄弟の中での順）から決まるので、同じマークアップからは同じ id・同じバイト列の kdr になる。後で `set` などから指すノードには `id` を書いておく（ノードの id はページの中で一意）',
    '- **エラー**: 知らない要素・属性、値の誤り、閉じ忘れは `kdr: build: design.xml:12: fill="red": …` のようにファイルと行番号を付けて標準エラーに出し、何も書き出さない（終了コード 1）',
    '- **書き出し**: `kdr -f a.kdr markup` は、今の kdr を同じ語彙のマークアップにして標準出力へ出す（ノードを指定すると、そのノードと子孫を `place` で置ける形で）。id はすべて書くので、直して `build` すれば同じ id のまま作り直せる。インスタンスの中身は書かず、元の側の上書きを `<override>` で書く。画像は `--assets フォルダ`（あるフォルダ）にファイルを書き出して `src` で指す（付けなければ書かない）。埋め込んだ書体・差し替えの候補・インスタンスの裏返しなど表せないものと、build し直すと元と違うところは、標準エラーに知らせる',
    '- **標準入力**: ファイル名の代わりに `-` と書くと、マークアップを標準入力から読む（`node make.mjs | kdr build - -o a.kdr`、`kdr -f a.kdr -w place - < part.xml`）。エラーの場所は `-:12:`、画像の `src` は今のディレクトリから数える。`place -` のときは、入力の kdr を `-f` のファイルで渡す',
    '- 繰り返しや変数はない。同じ形はコンポーネントとインスタンスで表すか、マークアップを作る側（スクリプトなど）で繰り返し、`build -` に渡す。コメントは `<!-- … -->`',
    '',
    '## 検査（lint）',
    '',
    '`kdr -f design.kdr lint` は、ドキュメント全体（全ページ）を次の検査にかけ、見つけたものを 1 行に `id<TAB>検査の名前<TAB>説明` で出す（ノードはページごとに `# ページ名  id` の見出しの下。書体のようにノードの無いものは id が `-` で、見出しの前）。`--json` なら `check`・`page`・`id`・`name`・`message` を持つオブジェクトの配列。',
    '見つかれば終了コード `1`、無ければ何も出さず `0`（`--json` は `[]`）。`--only` / `--skip` に検査の名前を `,` でつないで、動かす検査を選ぶ。インスタンスの中身（元の写し）は、元の側で 1 度だけ検査する（`low-contrast` だけは、背景が置いた場所で変わるのでインスタンスの中も見る）。',
    '',
    ...CHECKS.map((check) => `- \`${check.name}\`: ${check.description}${check.needs ? `（\`--${check.needs}\` を指定したときだけ）` : ''}`),
    '',
    '`--palette` は `#rrggbb` を `,` でつないだ並びか、色を書いたファイル（JSON・CSS など、中の `#rrggbb` を拾う）。',
    '',
    '## 例が前提にするドキュメント',
    '',
    '下の「コマンド」の例は、次のコマンドで作った `demo.kdr` があるディレクトリで、そのまま動く（`old.kdr` は変える前に取っておいた `demo.kdr` の写し、`icon.svg` と `photo.png` と `font.ttf` は手元の SVG と画像と書体ファイル、`design.xml` と `part.xml` は上の「マークアップ」のもの）。',
    '',
    `${fence}sh`,
    'kdr ' + EXAMPLE_DOCUMENT.join(' \\\n  '),
    fence,
    '',
    '## コマンド',
    '',
  ]
  for (const [title, kinds] of GROUPS) {
    out.push(`### ${title}`, '')
    for (const command of COMMANDS.values()) {
      if (!kinds.includes(command.kind)) continue
      out.push(`#### ${command.name}`, '', fence, `kdr ${command.usage}`, fence, '', command.summary, '')
      const examples = examplesOf(command.name)
      if (examples.length > 0) out.push(`${fence}sh`, ...examples, fence, '')
    }
  }
  return out.join('\n').trimEnd() + '\n'
}
