import { KDR_VERSION } from '../src/document/kdr.ts'
import { UsageError } from './args.ts'
import { COMMANDS, type Command } from './commands.ts'
import { EXAMPLES, EXAMPLE_DOCUMENT } from './examples.ts'

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
  if (name === 'help' || name === 'docs') return builtinHelp(name)
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

function builtinHelp(name: 'help' | 'docs'): string {
  return name === 'help'
    ? 'kdr help [コマンド]\n\nコマンドの説明と例を出す（kdr コマンド --help と同じ）。省くと全体のヘルプ\n'
    : 'kdr docs\n\nエージェント向けの全体のリファレンス（Docker 越しの呼び方・ノードの指定・出力の形・終了コード・すべてのコマンドと例）を Markdown で標準出力へ出す\n'
}

function overview(): string {
  const lines = [
    'kdr — kadrokreo の kdr ファイルをコマンドラインで調べ、編集する（kadrokreo という名前でも動く）',
    '',
    '使い方:',
    '  kdr [-f 入力.kdr] [-o 出力.kdr | -w] コマンド 引数… [+ コマンド 引数…]…',
    '',
    '  -f, --file   入力の kdr（- は標準入力。省略すると標準入力）',
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
    '## 書き方',
    '',
    `${fence}sh`,
    'kdr [-f 入力.kdr] [-o 出力.kdr | -w] コマンド 引数… [+ コマンド 引数…]…',
    fence,
    '',
    '- `-f` 入力の kdr（`-` か省略で標準入力）。先頭のコマンドが `new` なら入力なしで新しく作る',
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
    '',
    '## 終了コードとエラー',
    '',
    '- `0` 成功、`1` エラー（ファイルが読めない・kdr が壊れている・値が kdr の決まりに合わない `fill=red` など）、`2` 使い方の誤り（不明なコマンドやオプション、引数の不足、ノードが見つからない・名前があいまい、入出力の組み合わせの誤り）',
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
    '',
    '# 4. 見た目を確かめる',
    'kdr -f app.kdr png screen --to screen.png     # 画像のファイルへ',
    'kdr -f app.kdr svg-out screen --to -          # SVG を標準出力へ（文字なので読める）',
    fence,
    '',
    '- 見た目を確かめたいときは、`png … --to ファイル.png` で書き出して画像を見るか、`svg-out … --to -` の SVG を読む',
    '- 変える前に `ls` か `get` で今の値を確かめ、変えた後にもう一度 `get` で確かめると確実',
    '- 多くの変更は 1 回の実行に `+` でまとめると速い（Docker の起動が 1 回で済む）',
    '- `set` に渡せる項目は、`get ノード` の JSON のキーと同じ。入れ子は `.` でつなぎ（`layout.gap=8`）、配列は番号でつなぐ（`fills.0.color=#ff0000`）。よく使うものには略記がある（`fill=`・`stroke=`・`shadow.blur=`・`blur=`・`dash=`・`dashOffset=`・`join=`・`cornerRadius=8,8,0,0`）',
    '',
    '## 例が前提にするドキュメント',
    '',
    '下の「コマンド」の例は、次のコマンドで作った `demo.kdr` があるディレクトリで、そのまま動く（`icon.svg` と `photo.png` は手元の SVG と画像）。',
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
