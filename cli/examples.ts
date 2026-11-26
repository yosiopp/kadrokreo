// kdr help コマンド・kdr docs に出す例。コマンドの名前ごとに並べる。
// 例はどれも、下の EXAMPLE_DOCUMENT で作った demo.kdr（と変える前の写し old.kdr、icon.svg・photo.png・font.ttf、EXAMPLE_MARKUP の design.xml・part.xml）がある場所で、そのまま動く。
// cli/help.test.ts が、すべてのコマンドに例があること・すべての例が終了コード 0 で動くことを確かめる。
// パイプやリダイレクト（| > <）は使わない（1 回の kdr の実行で完結させる）。

/** 例が前提にする demo.kdr を作るコマンド（kdr の引数。docs にもこのまま載せる） */
export const EXAMPLE_DOCUMENT = [
  'new Demo',
  '+ add frame --name Card --id card --width 320 --height 200 fill=#f5f5ff cornerRadius=12',
  '+ add frame --name Button --id btn --parent card --x 16 --y 16 fill=#5b4cf5 cornerRadius=8',
  '+ add text --parent btn --name Label --text OK fill=#ffffff',
  '+ auto-layout btn padding=12 + component btn',
  '+ instance Button --id btn2 --name Secondary --parent card --x 120 --y 16',
  '+ add rect --name Box --id box --x 400 --width 80 --height 80 fill=#ff8800 stroke=#333333',
  '+ add ellipse --name Dot --id dot --x 440 --y 40 --width 60 --height 60 fill=#00aaff',
  '+ add path --name Arrow --id arrow --points "520,0 560,20 520,40" --closed fill=#222222',
  '-o demo.kdr',
]

/**
 * build / place の例が読むマークアップ（docs の「マークアップ」の節にもこのまま載せる）。
 * design.xml は全体（最上位が <kdr>）、part.xml は木の一部（demo.kdr の元 Button を使う）
 */
export const EXAMPLE_MARKUP: Readonly<Record<'design.xml' | 'part.xml', string>> = {
  'design.xml': `<kdr name="Demo">
  <page name="Page 1">
    <!-- 入れ子が親子、書いた順が重なり順（自動で並べるフレームでは並ぶ順） -->
    <frame name="Card" id="card" width="320" fill="#f5f5ff" cornerRadius="12" layout="column" gap="12" padding="16">
      <text name="Title" fontSize="18" fontWeight="700">タイトル</text>
      <text name="Body" width="fill" fill="#666666" lineHeight="24px">説明文は、親の幅いっぱいで折り返す。</text>
      <component name="Button" id="btn" fill="#5b4cf5" cornerRadius="8" layout="row" padding="8 16">
        <text name="Label" fill="#ffffff">OK</text>
      </component>
      <instance of="btn" name="Secondary" fill="#888888">
        <override node="Label" text="Cancel"/>
      </instance>
    </frame>
  </page>
</kdr>
`,
  'part.xml': `<frame name="Row" id="row" layout="row" gap="8" align="center">
  <ellipse name="Mark" width="12" height="12" fill="#00aaff"/>
  <text name="Caption" fontSize="12">元は今の kdr から探す</text>
  <instance of="Button">
    <override node="Label" text="追加"/>
  </instance>
</frame>
`,
}

export const EXAMPLES: Readonly<Record<string, readonly string[]>> = {
  new: [
    'kdr new Demo -o demo.kdr',
    'kdr new Demo + add frame --name Screen --width 375 --height 812 fill=#ffffff -o screen.kdr',
  ],
  build: [
    'kdr build design.xml -o design.kdr',
    'kdr build design.xml + set btn fill=#222222 + png Card --to card.png -o design.kdr   # 続けてほかのコマンドをつなげる',
  ],
  info: ['kdr -f demo.kdr info'],
  ls: [
    'kdr -f demo.kdr ls',
    'kdr -f demo.kdr ls Card',
    'kdr -f demo.kdr ls --all --json',
  ],
  get: [
    'kdr -f demo.kdr get Box',
    'kdr -f demo.kdr get btn layout.gap',
    'kdr -f demo.kdr get Arrow d   # パスの形を SVG の path の d で',
  ],
  find: ['kdr -f demo.kdr find label'],
  bounds: ['kdr -f demo.kdr bounds btn/Label'],
  css: [
    'kdr -f demo.kdr css Button',
    'kdr -f demo.kdr css Button --format tailwind',
    'kdr -f demo.kdr css Card --unit rem --color rgb',
  ],
  html: [
    'kdr -f demo.kdr html Card',
    'kdr -f demo.kdr html Card --format react',
    'kdr -f demo.kdr html Card --standalone',
  ],
  json: ['kdr -f demo.kdr json --pretty'],
  components: ['kdr -f demo.kdr components'],
  colors: [
    'kdr -f demo.kdr colors',
    'kdr -f demo.kdr colors --all --color rgb --json',
    'kdr -f demo.kdr colors Card   # Card とその中だけ',
  ],
  'text-styles': ['kdr -f demo.kdr text-styles', 'kdr -f demo.kdr text-styles --all --json'],
  shadows: ['kdr -f demo.kdr shadows --color hsl'],
  diff: [
    'kdr diff old.kdr demo.kdr   # 違いが無ければ何も出さない（終了コード 0）。違いがあれば 1',
    'kdr diff old.kdr demo.kdr --json',
  ],
  lint: [
    'kdr -f demo.kdr lint   # 見つかれば終了コード 1',
    'kdr -f demo.kdr lint --skip small-target,hidden --json',
    'kdr -f demo.kdr lint --only off-grid,off-palette --grid 4 --palette "#5b4cf5,#ffffff,#f5f5ff"',
  ],
  png: [
    'kdr -f demo.kdr png   # ページ全体を「Demo - Page 1.png」へ',
    'kdr -f demo.kdr png Card --scale 2 --to card.png',
    'kdr -f demo.kdr png Box Dot --each --to out',
    'kdr -f demo.kdr png Card --background "#ffffff" --to -   # 標準出力へ（パイプかリダイレクトで受ける）',
  ],
  'svg-out': [
    'kdr -f demo.kdr svg-out',
    'kdr -f demo.kdr svg-out Card --to card.svg',
    'kdr -f demo.kdr svg-out Card --no-ids --background "#ffffff" --to -',
  ],
  page: ['kdr -f demo.kdr page 1 + ls', 'kdr -f demo.kdr -w page-add Icons + add rect --name Square + page 1 + set Box fill=#000000'],
  'doc-name': ['kdr -f demo.kdr -w doc-name "Design system"'],
  'page-add': ['kdr -f demo.kdr -w page-add Icons --id icons + add rect --name Square'],
  'page-rename': ['kdr -f demo.kdr -w page-rename Home'],
  'page-rm': ['kdr -f demo.kdr -w page-add Draft + page-rm Draft'],
  'font-add': [
    'kdr -f demo.kdr -w font-add font.ttf + set btn/Label fontFamily="Kdr Test"   # 書体名はファイルから読む',
    'kdr -f demo.kdr -w font-add font.ttf --family Brand',
  ],
  'font-rm': ['kdr -f demo.kdr -w font-add font.ttf + font-rm "Kdr Test"'],
  add: [
    'kdr -f demo.kdr -w add rect --name Badge --parent card --x 16 --y 120 --width 40 --height 20 fill=#ff0000 cornerRadius=10',
    'kdr -f demo.kdr -w add text --parent card --x 16 --y 160 --text "こんにちは" fontSize=18 fill=#333333',
    'kdr -f demo.kdr -w add text --text "幅を決めると折り返す長い文章" --width 120',
    'kdr -f demo.kdr -w add line --from 0,250 --to 320,250 stroke=#cccccc dash=4,2',
    'kdr -f demo.kdr -w add path --d "M0 300 C40 260 80 340 120 300" stroke=#5b4cf5 endCap=arrow',
    'kdr -f demo.kdr -w add image --src photo.png --width 64',
    'kdr -f demo.kdr -w add star --name Rating --x 16 --y 360 --count 5 --width 24 fill=#f5b301',
    'kdr -f demo.kdr -w add polygon --name Badge --x 60 --y 360 --count 6 --height 40 fill=#5b4cf5',
    'kdr -f demo.kdr -w add frame --name Row --id row --y 300 --width 320 --height 48 + add ellipse --parent @ --width 24 --height 24',
  ],
  svg: ['kdr -f demo.kdr -w svg icon.svg --parent card --x 280 --y 16 --name Icon'],
  place: [
    'kdr -f demo.kdr -w place part.xml --parent card --x 16 --y 120',
    'kdr -f demo.kdr -w place part.xml --y 300 + set @ opacity=0.5   # ページ直下に置いて、置いたものを @ で指す',
  ],
  set: [
    'kdr -f demo.kdr -w set Box fill=#00ff00 cornerRadius=8',
    'kdr -f demo.kdr -w set Box Dot shadow.blur=8 shadow.y=4 opacity=0.8',
    'kdr -f demo.kdr -w set btn/Label text=送信 fontSize=16 fontWeight=700',
    'kdr -f demo.kdr -w set Box fill=null stroke=#333333 strokeWidth=2 dash=4,2 dashOffset=2 join=round',
    'kdr -f demo.kdr -w set Card cornerRadius=16,16,0,0 blur=4',
    'kdr -f demo.kdr -w set Box fills.0.opacity=0.5 constraints.horizontal=end',
    'kdr -f demo.kdr -w set Arrow radius=6',
    'kdr -f demo.kdr -w set card layout=column gap=8 padding="12 16" + set btn btn2 width=fill   # 自動で並べ、子を幅いっぱいに',
    'kdr -f demo.kdr -w set btn/Label fontSize=16 lineHeight=24px',
    'kdr -f demo.kdr -w set btn/Label letterSpacing=0.05em textDecoration=underline',
  ],
  gradient: [
    'kdr -f demo.kdr -w gradient linear Box --colors "#5b4cf5,#ffffff" --angle 90',
    'kdr -f demo.kdr -w gradient radial Dot --colors "#ffffff,#a99fff@30%,#5b4cf5" --center 50%,50% --radius 50%',
    'kdr -f demo.kdr -w gradient conic Box --colors "#ff0000,#00ff00,#0000ff,#ff0000" --add --opacity 0.5',
    'kdr -f demo.kdr -w gradient linear Box --stroke --from 0,0 --to 1,1',
  ],
  rm: ['kdr -f demo.kdr -w rm Box Dot'],
  mv: [
    'kdr -f demo.kdr -w mv Box --parent card',
    'kdr -f demo.kdr -w mv btn2 --root',
  ],
  order: ['kdr -f demo.kdr -w order back Dot'],
  dup: ['kdr -f demo.kdr -w dup Box --offset 100 + set @ fill=#00aa00'],
  join: ['kdr -f demo.kdr -w join Box Dot + set @ fill=#222222'],
  split: ['kdr -f demo.kdr -w join Box Dot + split @'],
  boolean: [
    'kdr -f demo.kdr -w boolean subtract Box Dot',
    'kdr -f demo.kdr -w boolean union Box Dot --keep + set @ booleanOperation=intersect',
  ],
  flatten: ['kdr -f demo.kdr -w boolean union Box Dot --keep + flatten @'],
  'outline-stroke': ['kdr -f demo.kdr -w outline-stroke Box'],
  'outline-text': ['kdr -f demo.kdr -w font-add font.ttf + set btn/Label fontFamily="Kdr Test" + outline-text btn/Label   # 埋め込んだ書体のテキストだけ'],
  'text-path': [
    'kdr -f demo.kdr -w add text --name Curve --text "Hello, path" + text-path Curve Arrow --offset 10',
    'kdr -f demo.kdr -w add text --name Ring --text Round + set Ring textAlign=center + text-path Ring Dot --offset 50 + rm Dot',
  ],
  mask: [
    'kdr -f demo.kdr -w mask Dot Box --name Masked',
    'kdr -f demo.kdr -w mask Dot Box --type luminance',
  ],
  align: [
    'kdr -f demo.kdr -w align top Box Dot Arrow',
    'kdr -f demo.kdr -w align center btn   # 1 つなら親フレームの中央へ',
  ],
  distribute: ['kdr -f demo.kdr -w distribute horizontal Box Dot Arrow'],
  rotate: [
    'kdr -f demo.kdr -w rotate 45 Box',
    'kdr -f demo.kdr -w rotate 90 Box Dot --each',
    'kdr -f demo.kdr -w rotate -15 Arrow --pivot 520,0',
  ],
  flip: ['kdr -f demo.kdr -w flip horizontal Arrow'],
  'auto-layout': [
    'kdr -f demo.kdr -w auto-layout card direction=vertical gap=8 padding=16',
    'kdr -f demo.kdr -w auto-layout card gap=8 wrap=true crossGap=8 sizing.height=hug',
    'kdr -f demo.kdr -w auto-layout btn --off',
  ],
  wrap: ['kdr -f demo.kdr -w wrap Box Dot --name Row --id row direction=horizontal gap=12 padding=8'],
  'layout-fill': [
    'kdr -f demo.kdr -w auto-layout card direction=vertical + layout-fill width btn btn2',
    'kdr -f demo.kdr -w auto-layout card direction=vertical + layout-fill width btn --off',
  ],
  component: ['kdr -f demo.kdr -w add frame --name Chip --id chip --y 300 + component chip'],
  detach: ['kdr -f demo.kdr -w detach btn2'],
  instance: [
    'kdr -f demo.kdr -w instance Button --parent card --x 16 --y 120 --id btn3',
    'kdr -f demo.kdr -w instance Button --id btn3 --y 300 + set btn3/Label text=Cancel   # インスタンスの中身を変えると上書きになる',
  ],
  swap: ['kdr -f demo.kdr -w add frame --name Chip --id chip --y 300 + component chip + swap btn2 Chip'],
  'override-push': ['kdr -f demo.kdr -w set btn2/Label fill=#ffff00 + override-push btn2'],
  'override-reset': ['kdr -f demo.kdr -w set btn2/Label text=Cancel + override-reset btn2'],
  'variant-add': [
    'kdr -f demo.kdr -w variant-add Button --id big 種類=大',
    'kdr -f demo.kdr -w variant-add Button --id big 種類=大 + set big fill=#222222',
  ],
  variant: ['kdr -f demo.kdr -w variant-add Button --id big 種類=大 + variant btn2 種類=大'],
  'variant-prop-add': ['kdr -f demo.kdr -w variant-add Button --id big 種類=大 + variant-prop-add big サイズ M'],
  'variant-prop-rename': ['kdr -f demo.kdr -w variant-add Button --id big 種類=大 + variant-prop-rename big 種類 スタイル'],
  'variant-prop-rm': [
    'kdr -f demo.kdr -w variant-add Button --id big 種類=大 + variant-prop-add big サイズ M + variant-prop-rm big サイズ',
  ],
  'variant-prop-order': [
    'kdr -f demo.kdr -w variant-add Button --id big 種類=大 + variant-prop-add big サイズ M + variant-prop-order big サイズ 0',
  ],
  'variant-value-order': ['kdr -f demo.kdr -w variant-add Button --id big 種類=大 + variant-value-order big 種類 大 0'],
  'variant-value-rename': ['kdr -f demo.kdr -w variant-add Button --id big 種類=大 + variant-value-rename big 種類 大 特大'],
  describe: ['kdr -f demo.kdr -w describe Button "主な操作に使うボタン"'],
  'prop-add': [
    'kdr -f demo.kdr -w prop-add Button text btn/Label --name 文言',
    'kdr -f demo.kdr -w prop-add Button boolean btn/Label --name ラベルを出す',
  ],
  'prop-rename': ['kdr -f demo.kdr -w prop-add Button text btn/Label --name 文言 + prop-rename Button 文言 ラベル'],
  'prop-order': [
    'kdr -f demo.kdr -w prop-add Button text btn/Label --name 文言 + prop-add Button boolean btn/Label --name 表示 + prop-order Button 表示 0',
  ],
  'prop-prefer': [
    'kdr -f demo.kdr -w add frame --name Icon --id icon --y 300 --width 24 --height 24 + component icon' +
      ' + instance Icon --parent btn + prop-add Button instance @ --name アイコン + prop-prefer Button アイコン Icon',
  ],
  'prop-rm': ['kdr -f demo.kdr -w prop-add Button text btn/Label --name 文言 + prop-rm Button 文言'],
  'prop-align': [
    'kdr -f demo.kdr -w variant-add Button --id big 種類=大 + prop-add big text big/Label --name 文言 + prop-align big',
  ],
  prop: ['kdr -f demo.kdr -w prop-add Button text btn/Label --name 文言 + prop btn2 文言=キャンセル'],
}

/**
 * 例の 1 行を argv に分ける（テストと docs 用の小さなもの）。'…' と "…" の引用、語の頭の # から行末までの説明（シェルと同じ）に対応する。
 * 先頭の kdr は取り除く。引用の外の | < > は使わない決まりなので、あればエラーにする
 */
export function splitExample(line: string): string[] {
  const args: string[] = []
  let current: string | null = null
  let quote: '"' | "'" | null = null
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (quote !== null) {
      if (c === quote) quote = null
      else current += c
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      current ??= ''
      continue
    }
    if (c === ' ') {
      if (current !== null) args.push(current)
      current = null
      continue
    }
    // シェルと同じく、語の頭の # から行末までは説明
    if (c === '#' && current === null) break
    if (c === '|' || c === '<' || c === '>') throw new Error(`例にパイプやリダイレクトは使えません: ${line}`)
    current = (current ?? '') + c
  }
  if (quote !== null) throw new Error(`引用が閉じていません: ${line}`)
  if (current !== null) args.push(current)
  if (args[0] !== 'kdr') throw new Error(`例は kdr で始めます: ${line}`)
  return args.slice(1)
}
