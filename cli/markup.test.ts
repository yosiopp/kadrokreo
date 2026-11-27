import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { decodeKdr } from '../src/document/kdr.ts'
import type { DesignDocument, FrameNode, ImageNode, RectNode, SceneNode, TextNode } from '../src/document/types.ts'
import { documentDifferences } from './markupCompare.ts'
import { type IO, run } from './run.ts'

// kdr build / kdr place（マークアップからノードを作る）と、それに合わせて set / add に足した略記

const encode = (text: string) => new TextEncoder().encode(text)

// 2×1 の PNG
const PNG = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEElEQVR42mP8z8Dwn4GBgQEADQMB/2xXUNoAAAAASUVORK5CYII='),
  (c) => c.charCodeAt(0),
)

function harness(files: Record<string, Uint8Array | string> = {}, stdin: string | null = null) {
  const fs = new Map(Object.entries(files).map(([path, data]) => [path, typeof data === 'string' ? encode(data) : data]))
  let stdout = ''
  let stderr = ''
  const io: IO = {
    readFile: async (path) => {
      const data = fs.get(path)
      if (!data) throw new Error(`ENOENT: ${path}`)
      return new Uint8Array(data)
    },
    writeFile: async (path, data) => {
      fs.set(path, data)
    },
    readStdin: async () => (stdin === null ? new Uint8Array() : encode(stdin)),
    stdinIsTTY: stdin === null,
    stdoutIsTTY: false,
    stdout: (data) => {
      if (typeof data === 'string') stdout += data
    },
    stderr: (text) => {
      stderr += text
    },
  }
  return {
    fs,
    run: (argv: string[]) => run(argv, io),
    get stdout() {
      return stdout
    },
    get stderr() {
      return stderr
    },
    async doc(path: string): Promise<DesignDocument> {
      return decodeKdr(new Blob([new Uint8Array(fs.get(path)!)]))
    },
  }
}

const byName = <N extends SceneNode = SceneNode>(doc: DesignDocument, name: string, page = 0) =>
  Object.values(doc.pages[page].nodes).find((node) => node.name === name) as N

const solid = (color: string) => [{ type: 'solid', color, opacity: 1, visible: true, blendMode: 'normal' }]

/** マークアップ 1 つから作ったドキュメント */
async function built(markup: string, files: Record<string, Uint8Array | string> = {}) {
  const h = harness({ 'a.xml': markup, ...files })
  const code = await h.run(['build', 'a.xml', '-o', 'a.kdr'])
  expect(h.stderr).toBe('')
  expect(code).toBe(0)
  return h.doc('a.kdr')
}

const SCREEN = `<kdr name="Demo">
  <page name="Page 1">
    <frame name="Screen" width="375" height="812" fill="#ffffff" layout="column">
      <frame name="Header" width="fill" layout="row" padding="16" align="center" justify="space-between">
        <text name="Title" fontSize="17" fontWeight="700">タイトル</text>
        <rect name="MenuIcon" width="24" height="24" fill="#cccccc"/>
      </frame>
      <frame name="Content" width="fill" height="fill" layout="column" gap="12" padding="16">
        <component name="ListItem" id="item" width="fill" fill="#f2f2f2" cornerRadius="8"
                   layout="row" gap="12" padding="12" align="center">
          <ellipse name="Avatar" width="40" height="40" fill="#cccccc"/>
          <text name="Label" fontSize="15">リストの項目 1</text>
        </component>
        <instance of="item" id="second" width="fill">
          <override node="Label" text="リストの項目 2"/>
        </instance>
      </frame>
    </frame>
  </page>
</kdr>`

describe('kdr build', () => {
  it('入れ子が親子、書いた順が重なり順になり、並べ直しが位置と大きさを決める', async () => {
    const doc = await built(SCREEN)
    expect(doc.name).toBe('Demo')
    expect(doc.pages.map((page) => page.name)).toEqual(['Page 1'])
    const page = doc.pages[0]
    const screen = byName<FrameNode>(doc, 'Screen')
    expect(page.rootIds).toEqual([screen.id])
    expect(screen.children.map((id) => page.nodes[id].name)).toEqual(['Header', 'Content'])
    expect(screen).toMatchObject({ width: 375, height: 812, sizing: { width: 'fixed', height: 'fixed' }, fills: solid('#ffffff') })
    // ヘッダーは幅いっぱい・高さは中身に合わせる。本文は残りの高さいっぱい
    const header = byName<FrameNode>(doc, 'Header')
    expect(header).toMatchObject({ x: 0, y: 0, width: 375, height: 56, sizing: { width: 'fill', height: 'hug' } })
    expect(header.layout).toMatchObject({ direction: 'horizontal', paddingTop: 16, paddingLeft: 16, gap: 0, align: 'center', justify: 'space-between' })
    expect(byName(doc, 'Content')).toMatchObject({ x: 0, y: 56, width: 375, height: 756 })
    expect(byName(doc, 'MenuIcon')).toMatchObject({ x: 335, y: 16 })
    // 元とインスタンス。インスタンスの中身は元の写しで、文言だけ上書き
    const main = page.nodes.item as FrameNode
    expect(main).toMatchObject({ x: 16, y: 16, width: 343, height: 64, component: { role: 'main' } })
    const second = page.nodes.second as FrameNode
    expect(second).toMatchObject({ name: 'ListItem', x: 16, y: 92, width: 343, height: 64, component: { role: 'instance' } })
    const labels = second.children.map((id) => page.nodes[id]).filter((node): node is TextNode => node.type === 'text')
    expect(labels.map((label) => label.text)).toEqual(['リストの項目 2'])
    const mainLabel = main.children.map((id) => page.nodes[id]).find((node) => node.type === 'text')!
    expect(second.component).toMatchObject({ overrides: { [mainLabel.id]: { text: 'リストの項目 2' } } })
  })

  it('書かなかった項目は kdr の既定値（塗りなし・線なし・余白 0・間隔 0）。テキストだけは黒の 16px', async () => {
    const doc = await built(`<kdr><page>
      <frame name="F" layout="row">
        <rect name="R" width="10" height="10"/>
        <text name="T">a</text>
      </frame>
      <line name="L" from="0,40" to="30,40"/>
      <path name="P" d="M0 50 L10 50 L5 60 Z"/>
    </page></kdr>`)
    expect(doc.name).toBe('Untitled')
    const frame = byName<FrameNode>(doc, 'F')
    expect(frame).toMatchObject({ fills: [], strokes: [], sizing: { width: 'hug', height: 'hug' } })
    expect(frame.layout).toEqual({
      direction: 'horizontal', gap: 0, paddingTop: 0, paddingRight: 0, paddingBottom: 0, paddingLeft: 0,
      align: 'start', justify: 'start', wrap: false, crossGap: 0, alignContent: 'auto', mode: 'flex', columns: 2, columnWidth: null,
    })
    expect(byName<RectNode>(doc, 'R')).toMatchObject({ fills: [], strokes: [] })
    expect(byName<TextNode>(doc, 'T')).toMatchObject({ fills: solid('#000000'), fontSize: 16, fontFamily: 'sans-serif', x: 10 })
    expect(byName(doc, 'L')).toMatchObject({ type: 'path', fills: [], strokes: [], x: 0, y: 40, width: 30 })
    expect(byName(doc, 'P')).toMatchObject({ type: 'path', closed: true, fills: [], strokes: [] })
  })

  it('属性は set と同じ語彙で読む（略記・入れ子・padding の 1〜4 個・lineHeight の px）', async () => {
    const doc = await built(`<kdr><page>
      <frame name="F" width="200" layout="column" padding="1 2 3" gap="4" stroke="#112233" strokeWidth="2" shadow.blur="6" opacity="0.5" cornerRadius="1,2,3,4">
        <text name="T" width="fill" lineHeight="24px" fontSize="12" textAlign="center">a</text>
        <rect name="Abs" x="150" y="5" width="10" height="10" layoutPositioning="absolute" constraints.horizontal="end"/>
      </frame>
    </page></kdr>`)
    const frame = byName<FrameNode>(doc, 'F')
    expect(frame).toMatchObject({ width: 200, strokes: solid('#112233'), strokeWidth: 2, opacity: 0.5, cornerRadius: [1, 2, 3, 4], sizing: { width: 'fixed', height: 'hug' } })
    expect(frame.layout).toMatchObject({ direction: 'vertical', paddingTop: 1, paddingRight: 2, paddingBottom: 3, paddingLeft: 2, gap: 4 })
    expect(frame.effects).toMatchObject([{ type: 'drop-shadow', blur: 6 }])
    // fontSize は lineHeight より後に書いても、先に読む
    expect(byName<TextNode>(doc, 'T')).toMatchObject({ lineHeight: 2, fontSize: 12, textAlign: 'center', width: 196, sizing: { width: 'fill' } })
    expect(byName(doc, 'Abs')).toMatchObject({ x: 150, y: 5, layoutPositioning: 'absolute', constraints: { horizontal: 'end', vertical: 'start' } })
  })

  it('字間（px・em）と文字の装飾を属性に書け、インスタンスでも上書きできる', async () => {
    const doc = await built(`<kdr><page>
      <text name="Link" fontSize="20" letterSpacing="0.05em" textDecoration="underline">ab</text>
      <component id="c" layout="row"><text name="L">ab</text></component>
      <instance of="c" name="I"><override node="L" letterSpacing="2px" textDecoration="line-through"/></instance>
    </page></kdr>`)
    expect(byName<TextNode>(doc, 'Link')).toMatchObject({ letterSpacing: 1, textDecoration: 'underline' })
    const [main, copy] = (Object.values(doc.pages[0].nodes).filter((node) => node.name === 'L') as TextNode[]).sort((a, b) => a.letterSpacing - b.letterSpacing)
    expect(main).toMatchObject({ letterSpacing: 0, textDecoration: 'none' })
    expect(copy).toMatchObject({ letterSpacing: 2, textDecoration: 'line-through' })
    // 字間の分（2 文字 × 2）だけ幅を測り直す
    expect(copy.width).toBe(main.width + 4)
  })

  it('テキストは要素の中身（字下げと前後の空行は除き、途中の改行は残す）か text 属性に書く', async () => {
    const doc = await built(`<kdr><page>
      <text name="A">
        1 行目  &lt;b&gt; &amp;
          2 行目
      </text>
      <text name="B" text="  そのまま  "/>
      <text name="C" width="50">折り返す長い文章です</text>
    </page></kdr>`)
    expect(byName<TextNode>(doc, 'A').text).toBe('1 行目  <b> &\n2 行目')
    expect(byName<TextNode>(doc, 'B').text).toBe('  そのまま  ')
    const wrapped = byName<TextNode>(doc, 'C')
    expect(wrapped).toMatchObject({ width: 50, sizing: { width: 'fixed' } })
    expect(wrapped.height).toBeGreaterThan(30)
  })

  it('同じマークアップからは同じバイト列の kdr になり、id は木の道筋（名前）で決まる', async () => {
    const a = harness({ 'a.xml': SCREEN })
    const b = harness({ 'a.xml': SCREEN })
    expect(await a.run(['build', 'a.xml', '-o', 'a.kdr'])).toBe(0)
    expect(await b.run(['build', 'a.xml', '-o', 'a.kdr'])).toBe(0)
    expect(Buffer.from(a.fs.get('a.kdr')!).equals(Buffer.from(b.fs.get('a.kdr')!))).toBe(true)
    // 兄弟を足しても、ほかのノードとページの id は変わらない
    const before = await a.doc('a.kdr')
    const after = await built(SCREEN.replace('<rect name="MenuIcon"', '<rect name="Badge" width="8" height="8"/><rect name="MenuIcon"'))
    expect(after.pages[0].id).toBe(before.pages[0].id)
    for (const name of ['Screen', 'Header', 'Title', 'MenuIcon', 'Content', 'Avatar']) expect(byName(after, name).id, name).toBe(byName(before, name).id)
    // 同じ名前の兄弟は、並びの番号で分ける
    const twins = await built('<kdr><page><rect width="1" height="1"/><rect width="1" height="1"/></page></kdr>')
    expect(new Set(twins.pages[0].rootIds).size).toBe(2)
  })

  it('親いっぱいに伸ばす指定が何段続いても落ち着き、仮の大きさからの変化に子が追従しない', async () => {
    const depth = 30
    const open = Array.from({ length: depth }, (_, i) => `<frame name="L${i}" width="fill" height="fill" layout="${i % 2 ? 'row' : 'column'}" padding="2">`).join('')
    const doc = await built(`<kdr><page><frame name="Root" width="800" height="600" layout="column" padding="2">${open}
      <text name="Leaf" width="fill">深いところのテキストは親の幅で折り返す。深いところのテキストは親の幅で折り返す。</text>
      <frame name="Abs" width="fill" height="fill"><rect name="R" x="10" y="10" width="20" height="20" constraints.horizontal="end" constraints.vertical="end"/></frame>
      ${'</frame>'.repeat(depth)}</frame></page></kdr>`)
    expect(byName(doc, 'L29')).toMatchObject({ width: 680, height: 480 })
    expect(byName(doc, 'Leaf')).toMatchObject({ x: 2, y: 2, width: 338, height: 39 })
    expect(byName(doc, 'Abs')).toMatchObject({ width: 338, height: 476 })
    expect(byName(doc, 'R')).toMatchObject({ x: 10, y: 10 })
  })

  it('画像の src は、マークアップのファイルからの相対パス。大きさを片方だけ書くと縦横比を保つ', async () => {
    const h = harness({
      'design/a.xml': `<kdr><page><image name="I" src="img/p.png" width="40"/><image name="J" src="img/p.png"/>
        <component name="C" id="c" width="50" height="50"><image name="Slot" src="img/p.png" width="10" height="10"/></component>
        <instance of="c" id="i" x="100"><override node="Slot" src="img/q.png"/></instance></page></kdr>`,
      'design/img/p.png': PNG,
      'design/img/q.png': Uint8Array.from([...PNG, 0]),
    })
    expect(await h.run(['build', 'design/a.xml', '-o', 'a.kdr'])).toBe(0)
    const doc = await h.doc('a.kdr')
    expect(Object.keys(doc.assets)).toHaveLength(2)
    expect(byName<ImageNode>(doc, 'I')).toMatchObject({ width: 40, height: 20 })
    expect(byName<ImageNode>(doc, 'J')).toMatchObject({ width: 2, height: 1, assetId: byName<ImageNode>(doc, 'I').assetId })
    const page = doc.pages[0]
    const copy = (page.nodes.i as FrameNode).children.map((id) => page.nodes[id])[0] as ImageNode
    expect(copy.assetId).not.toBe(byName<ImageNode>(doc, 'Slot').assetId)
  })

  it('インスタンスの上書き: 根の塗り、入れ子のインスタンスの差し替え、道筋と元の id での指定', async () => {
    const doc = await built(`<kdr><page>
      <component name="IconA" id="a" width="10" height="10" fill="#aa0000"/>
      <component name="IconB" id="b" width="20" height="20" fill="#0000bb"/>
      <component name="Button" id="btn" layout="row" gap="4" padding="4" fill="#eeeeee">
        <instance of="a" name="Icon"/>
        <frame name="Box" layout="row"><text name="Label" id="inner">in</text></frame>
        <text name="Label" id="outer">out</text>
      </component>
      <instance of="btn" id="i1" y="100" fill="#123456" stroke="#654321" opacity="0.5">
        <override node="Icon" of="IconB"/>
        <override node="Box/Label" text="IN"/>
        <override node="outer" text="OUT" fill="#ff0000" fontWeight="700" visible="false"/>
      </instance>
    </page></kdr>`)
    const page = doc.pages[0]
    const instance = page.nodes.i1 as FrameNode
    expect(instance).toMatchObject({ y: 100, opacity: 0.5, fills: solid('#123456'), strokes: solid('#654321') })
    const inside = (id: string): SceneNode[] => {
      const node = page.nodes[id]
      return [node, ...(node.type === 'frame' ? node.children.flatMap(inside) : [])]
    }
    const copies = inside('i1')
    expect(copies.find((node) => node.name === 'Icon')).toMatchObject({ width: 20, height: 20, fills: solid('#0000bb') })
    expect(copies.filter((node): node is TextNode => node.type === 'text').map((node) => [node.text, node.visible, node.fontWeight])).toEqual([
      ['IN', true, 400],
      ['OUT', false, 700],
    ])
    // 元は変わらない
    expect((page.nodes.outer as TextNode).text).toBe('out')
    expect(page.nodes.btn).toMatchObject({ fills: solid('#eeeeee') })
  })

  it('ページをいくつも書ける。ノードの id はページごと、元はどのページのものでも指せる', async () => {
    const doc = await built(`<kdr name="Two">
      <page name="部品" id="parts"><component name="Chip" id="chip" layout="row" padding="4"><text>chip</text></component></page>
      <page name="画面"><instance of="Chip" id="chip"/></page>
    </kdr>`)
    expect(doc.pages.map((page) => [page.id === 'parts', page.name])).toEqual([[true, '部品'], [false, '画面']])
    expect(doc.pages[1].nodes.chip).toMatchObject({ component: { role: 'instance' }, width: doc.pages[0].nodes.chip.width })
  })

  it('build は先頭にだけ置け、続けてほかのコマンドをつなげる', async () => {
    const h = harness({ 'a.xml': SCREEN })
    expect(await h.run(['build', 'a.xml', '+', 'set', 'second', 'opacity=0.5', '+', 'get', 'second', 'opacity', '-o', 'a.kdr'])).toBe(0)
    expect(h.stdout).toBe('0.5\n')
    const bad = harness({ 'a.xml': SCREEN, 'a.kdr': h.fs.get('a.kdr')! })
    expect(await bad.run(['-f', 'a.kdr', 'build', 'a.xml', '-o', 'b.kdr'])).toBe(2)
    expect(await bad.run(['new', '+', 'build', 'a.xml', '-o', 'b.kdr'])).toBe(2)
    expect(bad.fs.has('b.kdr')).toBe(false)
  })

  it('docs/examples/wireframe.xml から、wireframe.sh と同じ画面ができる', async () => {
    const doc = await built(readFileSync(new URL('../docs/examples/wireframe.xml', import.meta.url), 'utf8'))
    expect(doc.name).toBe('スマホ ワイヤーフレーム')
    const page = doc.pages[0]
    expect(page.nodes.screen).toMatchObject({ width: 375, height: 812 })
    expect(byName(doc, 'StatusBar')).toMatchObject({ y: 0, width: 375, height: 44 })
    expect(byName(doc, 'Header')).toMatchObject({ y: 44, width: 375, height: 56 })
    expect(byName(doc, 'Content')).toMatchObject({ y: 100, width: 375, height: 648 })
    expect(byName(doc, 'TabBar')).toMatchObject({ y: 748, width: 375, height: 64 })
    expect(byName(doc, 'Body')).toMatchObject({ x: 16, y: 247, width: 343, height: 42 })
    expect(page.nodes.item3).toMatchObject({ x: 16, y: 453, width: 343, height: 64 })
    expect(byName(doc, 'Tab4')).toMatchObject({ x: 307, y: 12 })
  })

  it('docs/examples/sample.kdr は、sample.xml から作ったものと同じ中身で、今の version で開ける', async () => {
    const example = (name: string) => new Uint8Array(readFileSync(new URL(`../docs/examples/${name}`, import.meta.url)))
    const h = harness({ 'sample.xml': example('sample.xml') })
    expect(await h.run(['build', 'sample.xml', '-o', 'sample.kdr'])).toBe(0)
    // gzip の結果は実装によって変わりうるので、展開した中身（tar）で比べる
    const tar = async (bytes: Uint8Array<ArrayBuffer>) =>
      new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer())
    const same = Buffer.compare(await tar(example('sample.kdr')), await tar(new Uint8Array(h.fs.get('sample.kdr')!))) === 0
    expect(same, '置いてある sample.kdr が sample.xml とずれている。kdr build docs/examples/sample.xml -o docs/examples/sample.kdr で作り直す').toBe(true)

    // viewer の見どころ（オートレイアウト・コンポーネントのインスタンス・入れ子のインスタンス）が入っている
    const doc = await decodeKdr(new Blob([example('sample.kdr')]))
    expect(doc.name).toBe('kadrokreo サンプル')
    const nodes = doc.pages[0].nodes
    expect(nodes.screen).toMatchObject({ width: 375, height: 812, layout: { direction: 'vertical' } })
    expect(nodes.task3).toMatchObject({ width: 343, component: { role: 'instance', id: (nodes.task as FrameNode).component!.id } })
    const mains = Object.values(nodes).filter((node) => node.type === 'frame' && node.component?.role === 'main')
    expect(mains.map((node) => node.name).sort()).toEqual(['Button', 'Tag', 'TaskItem'])
    expect(Object.values(nodes).filter((node) => node.type === 'text' && node.text === '共有')).toHaveLength(1)
  })

  it('書き間違いは「ファイル:行」を付けたエラーにし、何も書き出さない', async () => {
    const cases: [string, RegExp][] = [
      ['<kdr><page>\n<rect width="10" height="10" fill="red"/></page></kdr>', /^kdr: build: a\.xml:2: fill="red": .*#rrggbb/],
      ['<kdr><page>\n<rect width="10" height="10"\n  foo="1"/></page></kdr>', /a\.xml:3: foo="1": rect には foo がありません/],
      ['<kdr><page>\n<frame width="1" height="1">\n<circle/></frame></page></kdr>', /a\.xml:3: 知らない要素です: <circle>/],
      ['<kdr><page>\n<frame width="1" height="1">\n</frm></page></kdr>', /a\.xml:3: 閉じタグが合いません: <frame>（2 行目）/],
      ['<kdr><page>\n<frame width="1" height="1">', /a\.xml:2: 閉じていない要素があります: <frame>/],
      ['<kdr><page><rect width="1" width="2" height="1"/></page></kdr>', /a\.xml:1: 属性が重複しています: width/],
      ['<kdr><page><rect height="10"/></page></kdr>', /<rect> には width が要ります/],
      ['<kdr><page><rect width="fill" height="10"/></page></kdr>', /width="fill" は、自動で並べるフレーム/],
      ['<kdr><page><frame layout="row"><rect width="fill" height="10"/></frame></page></kdr>', /親の width が中身に合わせる/],
      ['<kdr><page><frame width="hug" height="10"/></page></kdr>', /width="hug" は、自動で並べるフレーム/],
      ['<kdr><page><rect width="hug" height="10"/></page></kdr>', /width="hug": .*中身に合わせられません/],
      ['<kdr><page><text height="3">a</text></page></kdr>', /height は指定できません/],
      ['<kdr><page><text text="a">b</text></page></kdr>', /要素の中身か text 属性のどちらか/],
      ['<kdr><page><rect width="1" height="1">文字</rect></page></kdr>', /<rect> の中に文字は書けません/],
      ['<kdr><page><rect width="1" height="1"><rect width="1" height="1"/></rect></page></kdr>', /<rect> の中に要素は書けません/],
      ['<kdr><page><rect id="a b" width="1" height="1"/></page></kdr>', /id="a b": id には英数字/],
      ['<kdr><page><rect id="a" width="1" height="1"/><rect id="a" width="1" height="1"/></page></kdr>', /id="a": id が重複しています/],
      ['<kdr><page><rect width="1" height="1" type="frame"/></page></kdr>', /type は属性では指定できません/],
      ['<kdr><page><text fontSize="abc">a</text></page></kdr>', /fontSize="abc": 数値ではありません/],
      ['<kdr><page><line from="0,0"/></page></kdr>', /<line> には to が要ります/],
      ['<kdr><page><path d="M0 0 X"/></page></kdr>', /a\.xml:1: d: /],
      ['<kdr><page><image src="nope.png"/></page></kdr>', /src="nope.png": 画像を読めません/],
      ['<kdr><page><instance of="nope"/></page></kdr>', /of="nope": コンポーネントの元（<component>）が見つかりません/],
      ['<kdr><page><component name="A" width="1" height="1"/><component name="A" width="1" height="1"/><instance of="A"/></page></kdr>', /同じ名前の元が 2 個/],
      ['<kdr><page><component id="a" width="9" height="9"/><instance of="a" width="20"/></page></kdr>', /インスタンスの大きさは元の <component> で決まります/],
      ['<kdr><page><component id="a" width="9" height="9"/>\n<instance of="a" cornerRadius="3"/></page></kdr>', /a\.xml:2: cornerRadius: インスタンスごとには変えられない項目/],
      ['<kdr><page><component id="a" layout="row"><text name="T">x</text></component>\n<instance of="a">\n<override node="Nope" text="y"/></instance></page></kdr>', /a\.xml:3: node="Nope": .*あるのは T）/],
      ['<kdr><page><component id="a" layout="row"><text name="T">x</text><text name="T">y</text></component><instance of="a"><override node="T" text="y"/></instance></page></kdr>', /同じ名前のレイヤーが 2 個/],
      ['<kdr><page><component id="a" layout="row"><text name="T">x</text></component><instance of="a"><override node="T" lineHeight="2"/></instance></page></kdr>', /lineHeight: インスタンスごとには変えられない項目/],
      ['<kdr><page><component id="a" layout="row"><text name="T">x</text></component><instance of="a"><override node="T" fill="null"/></instance></page></kdr>', /fills は、このレイヤーでは上書きできません/],
      ['<kdr><page><component id="a" layout="row"><text name="T">x</text></component><instance of="a"><rect width="1" height="1"/></instance></page></kdr>', /<instance> の中に書けるのは <override> だけ/],
      ['<kdr><page><component id="a" layout="row"><instance of="a"/></component></page></kdr>', /自分自身を含むことになります/],
      ['<kdr><page><override node="x"/></page></kdr>', /<override> は <instance> の中にだけ書けます/],
      ['<kdr foo="1"><page/></kdr>', /<kdr> に foo は指定できません/],
      ['<kdr><rect width="1" height="1"/></kdr>', /<kdr> の直下に書けるのは <page> だけ/],
      ['<kdr/>', /<kdr> には <page> が 1 つ以上要ります/],
      ['<frame width="1" height="1"/>', /最上位は <kdr> です（<frame> から始まる木の一部は、kdr place/],
      ['<!DOCTYPE kdr [<!ENTITY a "b">]><kdr><page/></kdr>', /DOCTYPE・ENTITY は書けません/],
      ['', /要素がありません/],
    ]
    for (const [markup, message] of cases) {
      const h = harness({ 'a.xml': markup })
      const code = await h.run(['build', 'a.xml', '-o', 'a.kdr'])
      expect(h.stderr, markup).toMatch(message)
      expect(code, markup).toBe(1)
      expect(h.fs.has('a.kdr'), markup).toBe(false)
    }
  })
})

const VARIANTS = `<kdr name="V">
  <page name="P">
    <frame name="Parts" x="0" y="0" layout="column" gap="16">
      <component name="Icon" id="icon" width="16" height="16" fill="#ff0000"/>
      <component name="Star" id="star" width="16" height="16" fill="#00ff00"/>
      <component-set name="Button" id="buttons" description="主な操作のボタン" layout="row" gap="8">
        <component variant="種類=標準, 大きさ=大" id="large" description="大きいボタン" layout="row" padding="8 16" gap="4" fill="#5b4cf5">
          <instance of="icon" name="Icon" prop="アイコン" prop.visible="アイコンを出す"/>
          <text name="Label" fill="#ffffff" prop="文言">OK</text>
        </component>
        <component variant="種類=標準, 大きさ=小" id="small" layout="row" padding="4 8" gap="4" fill="#5b4cf5">
          <instance of="icon" name="Icon"/>
          <text name="Label" fill="#ffffff" fontSize="12">OK</text>
        </component>
        <component variant="種類=控えめ, 大きさ=大" id="quiet" layout="row" padding="8 16" gap="4" fill="#dddddd">
          <instance of="icon" name="Icon"/>
          <text name="Label" prop="文言">OK</text>
        </component>
      </component-set>
    </frame>
    <frame name="Screen" x="400" y="0" layout="column" gap="8">
      <instance of="Button" id="b1"/>
      <instance of="Button" id="b2" variant="大きさ=小"/>
      <instance of="buttons" id="b3" variant="種類=控えめ">
        <override prop="文言" value="やめる"/>
        <override prop="アイコンを出す" value="false"/>
      </instance>
      <instance of="large" id="b4">
        <override prop="アイコン" value="star"/>
      </instance>
    </frame>
  </page>
</kdr>`

describe('kdr build のコンポーネントの説明文・プロパティ・バリアント', () => {
  it('説明文・プロパティ・バリアントを持つコンポーネントを、マークアップ 1 つから作れる', async () => {
    const doc = await built(VARIANTS)
    const page = doc.pages[0]
    const main = (id: string) => page.nodes[id] as FrameNode & { component: { role: 'main' } }
    const set = page.nodes.buttons as FrameNode
    expect(set.setDescription).toBe('主な操作のボタン')
    expect(set.children.map((id) => page.nodes[id].name)).toEqual(['種類=標準, 大きさ=大', '種類=標準, 大きさ=小', '種類=控えめ, 大きさ=大'])
    expect(main('large').component).toMatchObject({ role: 'main', description: '大きいボタン' })
    expect(main('small').component).toMatchObject({ role: 'main', description: '' })
    // プロパティは書いた順に作り、まとまりのすべてのバリアントで揃える（結ぶのはレイヤー名のたどり方が同じノード）
    for (const id of ['large', 'small', 'quiet']) {
      const variant = main(id)
      const child = (name: string) => variant.children.find((childId) => page.nodes[childId].name === name)
      expect(variant.component.properties, id).toEqual([
        { name: 'アイコン', type: 'instance', targets: [child('Icon')], preferred: [] },
        { name: 'アイコンを出す', type: 'boolean', targets: [child('Icon')], preferred: [] },
        { name: '文言', type: 'text', targets: [child('Label')], preferred: [] },
      ])
    }
    // バリアントは、まとまりを id か名前で指して variant で選ぶ。省いたプロパティは、指したもの（まとまりなら最初のバリアント）に近いもの
    const componentOf = (id: string) => (page.nodes[id] as FrameNode).component!.id
    expect(componentOf('b1')).toBe(componentOf('large'))
    expect(componentOf('b2')).toBe(componentOf('small'))
    expect(componentOf('b3')).toBe(componentOf('quiet'))
    expect(componentOf('b4')).toBe(componentOf('large'))
    expect(page.nodes.b1.name).toBe('Button')
    // インスタンスでの値は <override prop="…" value="…"/>
    const copies = (id: string) => (page.nodes[id] as FrameNode).children.map((childId) => page.nodes[childId])
    expect(copies('b3').find((node) => node.type === 'text')).toMatchObject({ text: 'やめる' })
    expect(copies('b3').find((node) => node.name === 'Icon')).toMatchObject({ visible: false })
    expect(copies('b4').find((node) => node.type === 'frame')).toMatchObject({ name: 'Star' })
  })

  it('variant に書いたプロパティの並びは問わない。place は、今の kdr のまとまりにもバリアントを足せる', async () => {
    const h = harness({
      'a.xml': VARIANTS,
      'part.xml': '<component variant="大きさ=小, 種類=控えめ" id="quietSmall" layout="row" fill="#eeeeee"><text name="Label" prop="文言">OK</text></component>',
      'use.xml': '<instance of="Button" variant="種類=控えめ, 大きさ=小" id="b5"><override prop="文言" value="あとで"/></instance>',
      'dup.xml': '<component variant="種類=標準, 大きさ=小" layout="row"/>',
    })
    expect(await h.run(['build', 'a.xml', '-o', 'a.kdr'])).toBe(0)
    const code = await h.run(['-f', 'a.kdr', '-o', 'b.kdr', 'place', 'part.xml', '--parent', 'buttons', '+', 'place', 'use.xml', '--parent', 'Screen'])
    expect(h.stderr).toBe('')
    expect(code).toBe(0)
    const page = (await h.doc('b.kdr')).pages[0]
    const added = page.nodes.quietSmall as FrameNode
    expect(added).toMatchObject({ name: '大きさ=小, 種類=控えめ', parentId: 'buttons' })
    // まとまりのほかのバリアントのプロパティも揃える（結ぶのはレイヤー名のたどり方が同じノード。ないものは結ばない）
    const label = added.children.find((id) => page.nodes[id].name === 'Label')
    expect(added.component).toMatchObject({
      properties: [
        { name: 'アイコン', type: 'instance', targets: [] },
        { name: 'アイコンを出す', type: 'boolean', targets: [] },
        { name: '文言', type: 'text', targets: [label] },
      ],
    })
    expect((page.nodes.b5 as FrameNode).component!.id).toBe(added.component!.id)
    expect((page.nodes.b5 as FrameNode).children.map((id) => page.nodes[id]).find((node) => node.type === 'text')).toMatchObject({ text: 'あとで' })
    // 同じ組み合わせは足せない
    const again = await h.run(['-f', 'a.kdr', '-o', 'c.kdr', 'place', 'dup.xml', '--parent', 'buttons'])
    expect(h.stderr).toMatch(/dup\.xml:1: variant="種類=標準, 大きさ=小": 同じ組み合わせのバリアント/)
    expect(again).toBe(1)
  })

  it('名前で作ったまとまり（<component-set> を使わないもの）は今までどおり。元の名前でもまとまりの名前でも指せ、place で variant なしの元も足せる', async () => {
    const h = harness({
      'a.xml': '<kdr><page><frame name="Btn" id="set" layout="row"><component name="size=L" width="10" height="10"/><component name="size=S" width="5" height="5"/></frame></page></kdr>',
      'use.xml': '<frame name="Uses" layout="row"><instance of="size=S" id="u1"/><instance of="Btn" id="u2" variant="size=S"/><instance of="Btn" id="u3"/></frame>',
      'add.xml': '<component name="size=M" id="m" width="7" height="7"/>',
    })
    expect(await h.run(['build', 'a.xml', '-o', 'a.kdr'])).toBe(0)
    const code = await h.run(['-f', 'a.kdr', '-o', 'b.kdr', 'place', 'use.xml', '+', 'place', 'add.xml', '--parent', 'set'])
    expect(h.stderr).toBe('')
    expect(code).toBe(0)
    const page = (await h.doc('b.kdr')).pages[0]
    const componentOf = (id: string) => (page.nodes[id] as FrameNode).component!.id
    const small = (page.nodes.set as FrameNode).children.map((id) => page.nodes[id]).find((node) => node.name === 'size=S')!
    const large = (page.nodes.set as FrameNode).children.map((id) => page.nodes[id]).find((node) => node.name === 'size=L')!
    expect(componentOf('u1')).toBe((small as FrameNode).component!.id)
    expect(componentOf('u2')).toBe((small as FrameNode).component!.id)
    expect(componentOf('u3')).toBe((large as FrameNode).component!.id)
    expect(page.nodes.m.parentId).toBe('set')
  })

  it('id は variant と name の書いた順によらない', async () => {
    const one = harness({ 'a.xml': VARIANTS.replace('<instance of="Button" id="b1"/>', '<instance of="Button" variant="大きさ=小" name="X"/>') })
    const two = harness({ 'a.xml': VARIANTS.replace('<instance of="Button" id="b1"/>', '<instance of="Button" name="X" variant="大きさ=小"/>') })
    expect(await one.run(['build', 'a.xml', '-o', 'a.kdr'])).toBe(0)
    expect(await two.run(['build', 'a.xml', '-o', 'a.kdr'])).toBe(0)
    expect(Buffer.from(one.fs.get('a.kdr')!).equals(Buffer.from(two.fs.get('a.kdr')!))).toBe(true)
  })

  it('書き間違い（ないプロパティ名・ないバリアントの値など）は行番号つきのエラーになる', async () => {
    const lines = VARIANTS.split('\n')
    const replace = (from: string, to: string) => {
      const at = lines.findIndex((line) => line.includes(from))
      expect(at, from).toBeGreaterThanOrEqual(0)
      return [lines.with(at, lines[at].replace(from, to)).join('\n'), at + 1] as const
    }
    const cases: (readonly [string, number, RegExp])[] = [
      [...replace('prop="文言" value="やめる"', 'prop="文字" value="やめる"'), /prop="文字": 元にそのプロパティがありません（あるもの: アイコン, アイコンを出す, 文言）/],
      [...replace('variant="種類=控えめ">', 'variant="種類=派手">'), /variant="種類=派手": 種類 に値 派手 がありません（あるもの: 標準, 控えめ）/],
      [...replace('variant="大きさ=小"/>', 'variant="色=赤"/>'), /variant="色=赤": プロパティ 色 がありません（あるもの: 種類, 大きさ）/],
      [...replace('variant="大きさ=小"/>', 'variant="大きさ"/>'), /variant="大きさ": 「プロパティ=値」をカンマでつないで/],
      [...replace('id="b4">', 'id="b4" variant="種類=控えめ, 大きさ=小">'), /その組み合わせのバリアントがありません/],
      [...replace('<instance of="Button" id="b1"/>', '<instance of="icon" id="b1" variant="種類=標準"/>'), /of="icon" の元は、バリアントのまとまり/],
      [...replace('value="false"', 'value="no"'), /value="no": アイコンを出す は表示のプロパティなので true か false/],
      [...replace('value="star"', 'value="nope"'), /value="nope": コンポーネントの元（<component>）が見つかりません/],
      [...replace('<override prop="文言" value="やめる"/>', '<override prop="文言"/>'), /<override prop="文言"> には value が要ります/],
      [...replace('<override prop="アイコンを出す" value="false"/>', '<override prop=" 文言 " value="x"/>'), /同じプロパティ 文言 への <override> が 2 つあります/],
      [...replace('<override prop="文言" value="やめる"/>', '<override prop="文言" value="x" fill="#000000"/>'), /<override> に fill は指定できません/],
      [...replace('<override prop="文言" value="やめる"/>', '<override node="Label" variant="種類=標準" text="x"/>'), /variant は of="…"（差し替える元）か prop="…"/],
      [...replace('variant="種類=標準, 大きさ=小" id="small"', 'id="small"'), /<component-set> の直下の <component> には variant が要ります/],
      [...replace('variant="種類=標準, 大きさ=小" id="small"', 'variant="種類=標準, 大きさ=大" id="small"'), /同じ組み合わせのバリアントが、このまとまりにもうあります/],
      [...replace('variant="種類=標準, 大きさ=小" id="small"', 'variant="種類=標準, 種類=小" id="small"'), /同じプロパティは 1 回だけ/],
      [...replace('variant="種類=標準, 大きさ=小" id="small"', 'variant="種類=標準, 大きさ=小" name="S" id="small"'), /name は書けません/],
      [...replace('<component name="Icon" id="icon"', '<component name="Icon" variant="a=b" id="icon"'), /variant は <component-set> の直下の <component> にだけ書けます/],
      [...replace('<text name="Label" prop="文言">OK</text>', '<rect name="Label" prop="文言" width="1" height="1"/>'), /prop: 文言のプロパティは <text>、差し替えのプロパティは <instance> に書きます/],
      [...replace('<text name="Label" prop="文言">OK</text>', '<text name="Label" prop.visible="文言">OK</text>'), /プロパティ 文言 は 文言のプロパティです（ここでは表示として結ぼうとしています）/],
      [...replace('<text name="Label" prop="文言">OK</text>', '<text name="Label" prop=" ">OK</text>'), /prop: プロパティの名前が空です/],
      [...replace('<instance of="Button" id="b1"/>', '<text prop="文言">x</text>'), /prop: コンポーネントのプロパティに結べるのは、<component> の中のノードだけ/],
      [...replace('<component name="Star" id="star" width="16" height="16" fill="#00ff00"/>', '<component name="Star" id="star" layout="row"><component-set><component variant="a=b" width="1" height="1"/></component-set></component>'), /<component-set> は <component> の中には書けません/],
      [...replace('<component name="Star" id="star" width="16" height="16" fill="#00ff00"/>', '<component-set name="Empty" width="1" height="1"/>'), /<component-set> には、バリアントの <component variant="…"> が 1 つ以上要ります/],
    ]
    // 結ぶノードのないバリアントのプロパティに値を入れる（小さいボタンからアイコンを外す）
    const noIcon = lines.map((line, i) => (i === lines.findIndex((other) => other.includes('<instance of="icon" name="Icon"/>')) ? '' : line))
    const b2 = noIcon.findIndex((line) => line.includes('id="b2"'))
    cases.push([noIcon.with(b2, '<instance of="Button" id="b2" variant="大きさ=小"><override prop="アイコンを出す" value="false"/></instance>').join('\n'), b2 + 1, /prop="アイコンを出す": この元では、プロパティ アイコンを出す に結んだノードがありません/])
    // まとまりの中の誤りは、先にそのまとまりを指すインスタンスがあっても、誤りの行で知らせる
    cases.push([VARIANTS.replace('variant="種類=標準, 大きさ=小" id="small"', 'id="small"').replace('<frame name="Parts"', '<instance of="Button"/><frame name="Parts"'), lines.findIndex((line) => line.includes('id="small"')) + 1, /variant が要ります/])
    for (const [markup, line, message] of cases) {
      const h = harness({ 'a.xml': markup })
      const code = await h.run(['build', 'a.xml', '-o', 'a.kdr'])
      expect(h.stderr, String(message)).toMatch(new RegExp(`a\\.xml:${line}: `))
      expect(h.stderr, String(message)).toMatch(message)
      expect(code, String(message)).toBe(1)
    }
  })
})

describe('kdr place', () => {
  const PART = `<frame name="Row" layout="row" gap="8" padding="4">
    <rect name="Dot" width="12" height="12" fill="#00aaff"/>
    <instance of="ListItem" name="Placed"><override node="Label" text="置いた行"/></instance>
  </frame>`

  async function base() {
    const h = harness({ 'a.xml': SCREEN, 'part.xml': PART })
    expect(await h.run(['build', 'a.xml', '-o', 'a.kdr'])).toBe(0)
    return h
  }

  it('木の一部を今のページに足す。元は今のドキュメントから探し、置いたものは @ で指せる', async () => {
    const h = await base()
    const code = await h.run(['-f', 'a.kdr', '-o', 'b.kdr', 'place', 'part.xml', '--parent', 'Content', '--index', '0', '+', 'set', '@', 'opacity=0.5'])
    expect(h.stderr).toBe('')
    expect(code).toBe(0)
    const doc = await h.doc('b.kdr')
    const page = doc.pages[0]
    const content = byName<FrameNode>(doc, 'Content')
    expect(content.children.map((id) => page.nodes[id].name)).toEqual(['Row', 'ListItem', 'ListItem'])
    const row = byName<FrameNode>(doc, 'Row')
    expect(row).toMatchObject({ x: 16, y: 16, opacity: 0.5, parentId: content.id })
    const placed = byName<FrameNode>(doc, 'Placed')
    expect(placed.component).toMatchObject({ role: 'instance', id: (page.nodes.item as FrameNode).component!.id })
    expect(placed.children.map((id) => page.nodes[id]).find((node) => node.type === 'text')).toMatchObject({ text: '置いた行' })
    // 前からあったものは、足した分だけ下へずれる
    expect(page.nodes.item).toMatchObject({ y: 16 + row.height + 12 })
  })

  it('同じものを 2 度置いても id がぶつからず、--x --y でページ直下の位置を決められる', async () => {
    const h = await base()
    expect(await h.run(['-f', 'a.kdr', '-o', 'b.kdr', 'place', 'part.xml', '--x', '500', '--y', '20', '+', 'place', 'part.xml', '--x', '500', '--y', '200'])).toBe(0)
    const doc = await h.doc('b.kdr')
    const rows = Object.values(doc.pages[0].nodes).filter((node) => node.name === 'Row')
    expect(rows.map((row) => [row.x, row.y, row.parentId])).toEqual([[500, 20, null], [500, 200, null]])
    expect(doc.pages[0].rootIds).toHaveLength(3)
    // 同じ入力からは同じ kdr
    const again = await base()
    await again.run(['-f', 'a.kdr', '-o', 'b.kdr', 'place', 'part.xml', '--x', '500', '--y', '20', '+', 'place', 'part.xml', '--x', '500', '--y', '200'])
    expect(Buffer.from(again.fs.get('b.kdr')!).equals(Buffer.from(h.fs.get('b.kdr')!))).toBe(true)
  })

  it('誤りは行番号つきで知らせ、入力のファイルは変えない', async () => {
    const h = await base()
    const before = h.fs.get('a.kdr')
    const cases: [string, string[], RegExp, number][] = [
      ['<kdr><page/></kdr>', [], /part\.xml:1: <kdr> から始まるマークアップは、kdr build/, 1],
      ['<rect width="1" height="1" id="item"/>', [], /id="item": id が重複しています/, 1],
      ['<rect width="fill" height="1"/>', ['--parent', 'Screen'], /^$/, 0],
      ['<rect width="fill" height="1"/>', [], /width="fill" は、自動で並べるフレーム/, 1],
      ['<rect width="1" height="1"/>', ['--parent', 'second'], /インスタンスの中には置けません/, 2],
      ['<rect width="1" height="1"/>', ['--parent', 'MenuIcon'], /フレームではありません/, 2],
    ]
    for (const [markup, options, message, expected] of cases) {
      h.fs.set('part.xml', encode(markup))
      const run = harness(Object.fromEntries(h.fs))
      const code = await run.run(['-f', 'a.kdr', '-w', 'place', 'part.xml', ...options])
      expect(run.stderr, markup).toMatch(message)
      expect(code, markup).toBe(expected)
      if (expected !== 0) expect(run.fs.get('a.kdr'), markup).toBe(before)
    }
  })
})

describe('kdr markup（ノードの木をマークアップに書き出す）', () => {
  /** kdr を markup で書き出し、build し直す。書き出した文字・標準エラー・作り直したドキュメント */
  async function roundTrip(h: ReturnType<typeof harness>, input: string, extra: string[] = []) {
    const code = await h.run(['-f', input, 'markup', ...extra])
    expect(code).toBe(0)
    const text = h.stdout
    const warnings = h.stderr
    h.fs.set('out.xml', encode(text))
    expect(await h.run(['build', 'out.xml', '-o', 'rebuilt.kdr'])).toBe(0)
    return { text, warnings, original: await h.doc(input), rebuilt: await h.doc('rebuilt.kdr') }
  }

  it('docs/examples/sample.kdr を書き出して build し直すと、元と同じドキュメントになり、もう一度書き出すと同じ文字になる', async () => {
    const h = harness({ 'sample.kdr': readFileSync('docs/examples/sample.kdr') })
    const { text, warnings, original, rebuilt } = await roundTrip(h, 'sample.kdr')
    expect(warnings).toBe('')
    expect(documentDifferences(original, rebuilt)).toEqual([])
    // id はすべて書き、インスタンスの中身は書かない（上書きだけ）
    expect(text).toContain('<instance id="task1" of="task" name="Task 1" width="fill">')
    expect(text).toContain('<override node="Title" text="ワイヤーフレームを描く" fill="#8a8aa0"/>')
    const again = harness({ 'rebuilt.kdr': h.fs.get('rebuilt.kdr')! })
    expect(await again.run(['-f', 'rebuilt.kdr', 'markup'])).toBe(0)
    expect(again.stdout).toBe(text)
  })

  it('説明文・プロパティ・バリアントも、#42 の語彙で書き出して同じものに戻る', async () => {
    const h = harness({ 'a.xml': VARIANTS })
    expect(await h.run(['build', 'a.xml', '-o', 'a.kdr'])).toBe(0)
    const { text, warnings, original, rebuilt } = await roundTrip(h, 'a.kdr')
    expect(warnings).toBe('')
    expect(documentDifferences(original, rebuilt)).toEqual([])
    expect(text).toContain('<component-set id="buttons" name="Button" description="主な操作のボタン"')
    expect(text).toContain('variant="種類=標準, 大きさ=大" description="大きいボタン"')
    expect(text).toMatch(/<instance id="[^"]+" of="icon" prop="アイコン" prop.visible="アイコンを出す"\/>/)
    // 入れ子の差し替えは、差し替える前の名前では見つからないので、元の側の id で指す
    expect(text).toMatch(/<override node="[A-Za-z0-9]{12}" of="star"\/>/)
  })

  it('文字・名前の特殊な文字、パス、グラデーション、入れ子の項目、画像（--assets）も元に戻る', async () => {
    const h = harness({ 'p.png': PNG })
    const made = await h.run([
      'new', 'A "B" <C>',
      '+', 'add', 'frame', '--name', 'Root', '--id', 'root', '--width', '300', '--height', '200',
      '+', 'add', 'image', '--src', 'p.png', '--parent', 'root', '--id', 'img', '--x', '10', '--y', '10', '--width', '40',
      '+', 'add', 'path', '--name', 'Curve', '--id', 'curve', '--d', 'M0 0 C 20 40 60 40 80 0', '--parent', 'root',
      '+', 'add', 'path', '--name', 'Tri', '--id', 'tri', '--points', '0,0 50,10 30,60', '--closed', '--parent', 'root',
      '+', 'set', 'tri', 'radius=4', 'rotation=15',
      '+', 'add', 'text', '--name', '[下書き]', '--id', 't1', '--text', '  前に空白\n<&> 2 行目', '--parent', 'root',
      '+', 'add', 'text', '--name', 'Plain', '--id', 't2', '--text', 'a < b & c', '--parent', 'root',
      '+', 'add', 'rect', '--name', 'G', '--id', 'g', '--width', '40', '--height', '40', '--parent', 'root',
      '+', 'gradient', 'linear', 'g', '--colors', '#ff0000,#0000ff',
      '+', 'set', 'g', 'constraints.horizontal=center', 'opacity=0.5', 'shadow.blur=4',
      '-o', 'a.kdr',
    ])
    expect(h.stderr).toBe('')
    expect(made).toBe(0)
    const { text, warnings, original, rebuilt } = await roundTrip(h, 'a.kdr', ['--assets', 'assets'])
    expect(warnings).toBe('')
    expect(documentDifferences(original, rebuilt)).toEqual([])
    expect(text).toContain('<text id="t2" name="Plain">a &lt; b &amp; c</text>')
    expect(text).toContain('text="  前に空白&#10;&lt;&amp;&gt; 2 行目"')
    expect(text).toContain('constraints.horizontal="center"')
    expect(text).toMatch(/<image id="img" src="assets\/[0-9a-f]+\.png"/)
    expect([...h.fs.keys()].some((path) => path.startsWith('assets/'))).toBe(true)
  })

  it('表せずに落としたものと、作り直すと元と違うところは、標準エラーに知らせる', async () => {
    const h = harness({ 'p.png': PNG })
    expect(
      await h.run([
        'new', 'D',
        '+', 'add', 'image', '--src', 'p.png', '--id', 'img',
        '+', 'add', 'frame', '--name', 'Comp', '--id', 'comp', '--x', '100', '--width', '30', '--height', '30', '+', 'component', 'comp',
        '+', 'add', 'frame', '--name', 'Holder', '--id', 'holder', '--x', '200', '--width', '30', '--height', '30',
        '+', 'instance', 'Comp', '--id', 'nest', '--parent', 'holder', '+', 'component', 'holder',
        '+', 'prop-add', 'holder', 'instance', 'nest', '--name', '差し替え', '+', 'prop-prefer', 'holder', '差し替え', 'Comp',
        '+', 'instance', 'Comp', '--id', 'i1', '--x', '300', '+', 'flip', 'horizontal', 'i1',
        '-o', 'a.kdr',
      ]),
    ).toBe(0)
    expect(await h.run(['-f', 'a.kdr', 'markup'])).toBe(0)
    expect(h.stderr).toMatch(/書き出せないもの: 画像 Image（img）（--assets でフォルダを指定すると書き出せる）/)
    expect(h.stderr).toMatch(/書き出せないもの: 元 Holder（holder） のプロパティ 差し替え の差し替えの候補/)
    expect(h.stderr).toMatch(/書き出せないもの: インスタンス Comp（i1） の裏返し/)
    expect(h.stderr).toMatch(/作り直すと元と違う: Image（img） がない/)
    expect(h.stdout).not.toContain('<image')
  })

  it('どんな kdr でも、書き出したものは build できる（親が自動で並べないのに残った fill、書き出さない画像への上書き、文字の null、ページをまたいで同じ id の元）', async () => {
    const cases: string[][] = [
      ['new', 'D', '+', 'add', 'frame', '--id', 'h', '--name', 'H', '--width', '200', '--height', '200', '+', 'auto-layout', 'h', '+', 'add', 'rect', '--id', 'a', '--parent', 'h', '+', 'layout-fill', 'width', 'a', '+', 'auto-layout', 'h', '--off'],
      ['new', 'D', '+', 'add', 'rect', '--id', 'r', '+', 'set', 'r', 'width=fill'],
      ['new', 'D', '+', 'add', 'frame', '--name', 'Card', '--id', 'card', '--width', '100', '--height', '100', '+', 'add', 'image', '--src', 'p.png', '--id', 'img', '--parent', 'Card', '--name', 'Pic', '+', 'component', 'card', '+', 'instance', 'Card', '--id', 'i1', '--x', '200', '+', 'set', 'i1/Pic', 'visible=false'],
      ['new', 'D', '+', 'add', 'text', '--name', 'null', '--id', 't1', '--text', 'null'],
      ['new', 'D', '+', 'add', 'frame', '--id', 'c', '--name', 'C', '--width', '50', '--height', '50', '+', 'component', 'c', '+', 'instance', 'c', '--id', 'i1', '--x', '100', '+', 'page-add', 'P2', '+', 'add', 'frame', '--id', 'c', '--name', 'C2', '--width', '60', '--height', '60', '+', 'component', 'c', '+', 'instance', 'C2', '--id', 'i2', '--x', '100'],
    ]
    for (const args of cases) {
      const h = harness({ 'p.png': PNG })
      expect(await h.run([...args, '-o', 'a.kdr']), args.join(' ')).toBe(0)
      expect(await h.run(['-f', 'a.kdr', 'markup']), args.join(' ')).toBe(0)
      expect(h.stderr, args.join(' ')).not.toMatch(/build し直せません/)
      h.fs.set('out.xml', encode(h.stdout))
      expect(await h.run(['build', 'out.xml', '-o', 'b.kdr']), args.join(' ')).toBe(0)
    }
  })

  it('ノードを指定すると、そのノードと子孫を place で置ける形で書き出す', async () => {
    const h = harness({ 'sample.kdr': readFileSync('docs/examples/sample.kdr') })
    expect(await h.run(['-f', 'sample.kdr', 'markup', 'Header'])).toBe(0)
    expect(h.stdout).toMatch(/^<frame id="[^"]+" name="Header" layout="row"/)
    // 根の「親いっぱいに伸ばす」は、置く先で決まるので数値にする
    expect(h.stdout.split('\n')[0]).toContain('width="375"')
    expect(h.stderr).toMatch(/Header（[^)]+）の親いっぱいに伸ばす大きさ/)
    h.fs.set('header.xml', encode(h.stdout))
    expect(await h.run(['new', 'X', '+', 'place', 'header.xml', '-o', 'x.kdr'])).toBe(0)
    expect(byName(await h.doc('x.kdr'), 'Heading')).toMatchObject({ text: '今日のタスク' })
  })
})

describe('マークアップを標準入力から読む（build - / place -）', () => {
  it('build - は標準入力のマークアップから kdr を作り、ファイルから作ったものと同じになる。画像の src は今のディレクトリから', async () => {
    const markup = '<kdr name="S"><page><frame name="F" x="0" y="0" layout="row"><image src="img/a.png"/><text>標準入力</text></frame></page></kdr>'
    const piped = harness({ 'img/a.png': PNG }, markup)
    const code = await piped.run(['build', '-', '-o', 'a.kdr'])
    expect(piped.stderr).toBe('')
    expect(code).toBe(0)
    const file = harness({ 'img/a.png': PNG, 'a.xml': markup })
    expect(await file.run(['build', 'a.xml', '-o', 'a.kdr'])).toBe(0)
    expect(Buffer.from(piped.fs.get('a.kdr')!).equals(Buffer.from(file.fs.get('a.kdr')!))).toBe(true)
  })

  it('エラーの場所は「-:行」で出る', async () => {
    const h = harness({}, '<kdr><page>\n<rect width="10" height="10" fill="red"/></page></kdr>')
    expect(await h.run(['build', '-', '-o', 'a.kdr'])).toBe(1)
    expect(h.stderr).toMatch(/^kdr: build: -:2: fill="red": /)
  })

  it('place - は、入力の kdr を -f のファイルで渡したときだけ読める', async () => {
    const base = harness({ 'a.xml': SCREEN })
    expect(await base.run(['build', 'a.xml', '-o', 'a.kdr'])).toBe(0)
    const piped = harness(Object.fromEntries(base.fs), '<rect name="Piped" width="5" height="5"/>')
    expect(await piped.run(['-f', 'a.kdr', '-o', 'b.kdr', 'place', '-', '--x', '600'])).toBe(0)
    expect(byName(await piped.doc('b.kdr'), 'Piped')).toMatchObject({ x: 600, width: 5 })
    // 入力の kdr も標準入力なら、kdr として読む前に断る
    const both = harness(Object.fromEntries(base.fs), '<rect width="5" height="5"/>')
    expect(await both.run(['-o', 'b.kdr', 'place', '-'])).toBe(2)
    expect(both.stderr).toMatch(/入力の kdr を -f のファイルで渡してください/)
    // 標準入力は 1 回しか読めない
    const twice = harness(Object.fromEntries(base.fs), '<rect width="5" height="5"/>')
    expect(await twice.run(['-f', 'a.kdr', '-o', 'b.kdr', 'place', '-', '+', 'place', '-'])).toBe(2)
    expect(twice.stderr).toMatch(/標準入力（-）はもう読んでいます/)
  })

  it('標準入力が端末なら、待たずに断る', async () => {
    const h = harness()
    expect(await h.run(['build', '-', '-o', 'a.kdr'])).toBe(2)
    expect(h.stderr).toMatch(/標準入力（-）が端末です/)
  })
})

describe('set / add の大きさと並べ方の略記', () => {
  it('layout=row|column で、余白も間隔も 0 から自動で並べる。並べ方の項目は layout. を付けずに書ける', async () => {
    const h = harness()
    const code = await h.run([
      'new', '+', 'add', 'frame', '--id', 'f', '--width', '200', 'gap=8', 'layout=column', 'padding=12 40', 'align=center',
      '+', 'add', 'rect', '--parent', 'f', '--id', 'r', '--width', '20', '--height', '20',
      '+', 'add', 'text', '--parent', 'f', '--id', 't', '--text', 'a', 'lineHeight=24px', 'fontSize=12', 'width=fill',
      '-o', 'a.kdr',
    ])
    expect(h.stderr).toBe('')
    expect(code).toBe(0)
    const doc = await h.doc('a.kdr')
    const frame = doc.pages[0].nodes.f as FrameNode
    // 大きさは中身に合わせる（hug）。--width で決めた向きは固定のまま
    expect(frame.layout).toMatchObject({ direction: 'vertical', gap: 8, paddingTop: 12, paddingRight: 40, paddingBottom: 12, paddingLeft: 40, align: 'center' })
    expect(frame).toMatchObject({ width: 200, sizing: { width: 'fixed', height: 'hug' } })
    expect(doc.pages[0].nodes.r).toMatchObject({ x: 90, y: 12 })
    expect(doc.pages[0].nodes.t).toMatchObject({ lineHeight: 2, sizing: { width: 'fill', height: 'hug' }, y: 40 })
  })

  it('width / height は fill・hug・数値。数値なら、その大きさで固定にする', async () => {
    const h = harness()
    await h.run(['new', '+', 'add', 'frame', '--id', 'f', 'layout=row', '+', 'add', 'rect', '--parent', 'f', '--id', 'r', '+', 'add', 'text', '--id', 't', '--text', 'あいうえお', '-o', 'a.kdr'])
    const code = await h.run(['-f', 'a.kdr', '-w', 'set', 'f', 'width=300', 'direction=vertical', '+', 'set', 'r', 'width=fill', 'height=30', '+', 'set', 't', 'width=40'])
    expect(h.stderr).toBe('')
    expect(code).toBe(0)
    const doc = await h.doc('a.kdr')
    expect(doc.pages[0].nodes.f).toMatchObject({ width: 300, height: 30, sizing: { width: 'fixed', height: 'hug' }, layout: { direction: 'vertical' } })
    expect(doc.pages[0].nodes.r).toMatchObject({ width: 300, height: 30, sizing: { width: 'fill', height: 'fixed' } })
    // テキストは幅を決めると、その幅で折り返す
    const text = doc.pages[0].nodes.t as TextNode
    expect(text).toMatchObject({ width: 40, sizing: { width: 'fixed', height: 'hug' } })
    expect(text.height).toBeGreaterThan(30)
    // hug に戻せる。並べないフレームには並べ方の項目を書けない
    expect(await h.run(['-f', 'a.kdr', '-w', 'set', 't', 'width=hug', '+', 'set', 'f', 'layout=row'])).toBe(0)
    expect((await h.doc('a.kdr')).pages[0].nodes.t).toMatchObject({ width: 80, sizing: { width: 'hug' } })
    const bad = harness()
    expect(await bad.run(['new', '+', 'add', 'frame', 'gap=8', '-o', 'b.kdr'])).toBe(2)
    expect(bad.stderr).toMatch(/layout\.gap: 先に layout=row\|column\|grid か auto-layout/)
    expect(await bad.run(['new', '+', 'add', 'frame', 'layout=row', 'padding=1 2 3 4 5', '-o', 'b.kdr'])).toBe(2)
    expect(await bad.run(['new', '+', 'add', 'text', 'lineHeight=px', '-o', 'b.kdr'])).toBe(2)
  })
})

describe('グリッド（layout="grid"）', () => {
  const GRID = `<kdr name="Grid"><page name="P">
<frame name="Cards" id="cards" width="300" layout="grid" columns="3" gap="10" crossGap="6" padding="20">
  <rect name="A" id="a" width="30" height="20"/>
  <rect name="B" id="b" width="50" height="40"/>
  <rect name="C" id="c" width="fill" height="fill"/>
  <rect name="D" id="d" width="20" height="10"/>
</frame>
</page></kdr>`

  it('build でグリッドに並べ、markup で同じ形に書き出して戻る。伸ばす子はセルいっぱい', async () => {
    const h = harness({ 'a.xml': GRID })
    expect(await h.run(['build', 'a.xml', '-o', 'a.kdr'])).toBe(0)
    const doc = await h.doc('a.kdr')
    const nodes = doc.pages[0].nodes
    expect((nodes.cards as FrameNode).layout).toMatchObject({ mode: 'grid', columns: 3, gap: 10, crossGap: 6 })
    // 内側 260、列の幅 (260 - 20) / 3 = 80。C は 1 行目の高さ 40 まで伸びる。D は 2 行目
    expect(nodes.c).toMatchObject({ x: 200, y: 20, width: 80, height: 40 })
    expect(nodes.d).toMatchObject({ x: 20, y: 66 })
    expect(nodes.cards).toMatchObject({ width: 300, height: 96 })
    expect(await h.run(['-f', 'a.kdr', 'markup'])).toBe(0)
    expect(h.stdout).toContain('layout="grid" padding="20" columns="3" gap="10" crossGap="6"')
    h.fs.set('out.xml', encode(h.stdout))
    expect(await h.run(['build', 'out.xml', '-o', 'b.kdr'])).toBe(0)
    expect(documentDifferences(doc, await h.doc('b.kdr'))).toEqual([])
  })

  it('set で並べ方・列の数・列の幅を変えると並び直す。不正な値はエラー', async () => {
    const h = harness({ 'a.xml': GRID })
    expect(await h.run(['build', 'a.xml', '-o', 'a.kdr'])).toBe(0)
    expect(await h.run(['-f', 'a.kdr', '-w', 'set', 'cards', 'columns=2', 'columnWidth=100', 'justify=end'])).toBe(0)
    let nodes = (await h.doc('a.kdr')).pages[0].nodes
    // 列の幅 100 × 2 + 間隔 10 = 210、余り 50 を先に空ける
    expect(nodes.a).toMatchObject({ x: 70, y: 20 })
    expect(nodes.b).toMatchObject({ x: 180, y: 20 })
    expect(nodes.c).toMatchObject({ x: 70, width: 100 })
    expect(await h.run(['-f', 'a.kdr', '-w', 'set', 'cards', 'columnWidth=null', 'layout=row'])).toBe(0)
    nodes = (await h.doc('a.kdr')).pages[0].nodes
    expect((nodes.cards as FrameNode).layout).toMatchObject({ mode: 'flex', direction: 'horizontal', columns: 2, columnWidth: null })
    for (const bad of ['columns=0', 'columns=1.5', 'columnWidth=0', 'mode=table']) {
      expect(await h.run(['-f', 'a.kdr', '-w', 'set', 'cards', bad])).not.toBe(0)
    }
    expect(await h.run(['-f', 'a.kdr', '-w', 'auto-layout', 'cards', 'mode=grid', 'columns=4'])).toBe(0)
    expect(((await h.doc('a.kdr')).pages[0].nodes.cards as FrameNode).layout).toMatchObject({ mode: 'grid', columns: 4 })
  })
})

describe('実装側の部品の対応（code・code-prop・html）', () => {
  const LINKED = VARIANTS.replace(
    '<component name="Star" id="star" width="16" height="16" fill="#00ff00"/>',
    '<component name="Star" id="star" width="16" height="16" fill="#00ff00" code="StarIcon" code-from="@/icons"/>',
  ).replace(
    '<component-set name="Button" id="buttons" description="主な操作のボタン" layout="row" gap="8">',
    `<component-set name="Button" id="buttons" description="主な操作のボタン" layout="row" gap="8" code="Button" code-from="@/ui">
        <code-prop property="種類" prop="variant"><code-value of="標準" to="primary"/><code-value of="控えめ" to="quiet"/></code-prop>
        <code-prop property="大きさ" prop="size"/>
        <code-prop property="文言" prop="children"/>
        <code-prop property="アイコンを出す" prop="showIcon"/>
        <code-prop property="アイコン" prop="icon"/>`,
  )

  it('マークアップで書いた対応が kdr に入り、markup で同じ形に書き出して戻る', async () => {
    const h = harness({ 'a.xml': LINKED })
    expect(await h.run(['build', 'a.xml', '-o', 'a.kdr'])).toBe(0)
    const doc = await h.doc('a.kdr')
    expect(byName<FrameNode>(doc, 'Button').setCode).toEqual({
      name: 'Button',
      from: '@/ui',
      defaultExport: false,
      props: [
        { property: '種類', prop: 'variant', values: { 標準: 'primary', 控えめ: 'quiet' } },
        { property: '大きさ', prop: 'size', values: {} },
        { property: '文言', prop: 'children', values: {} },
        { property: 'アイコンを出す', prop: 'showIcon', values: {} },
        { property: 'アイコン', prop: 'icon', values: {} },
      ],
    })
    expect(await h.run(['-f', 'a.kdr', 'markup'])).toBe(0)
    expect(h.stderr).toBe('')
    expect(h.stdout).toContain('<code-prop property="種類" prop="variant">\n          <code-value of="標準" to="primary"/>')
    h.fs.set('out.xml', encode(h.stdout))
    expect(await h.run(['build', 'out.xml', '-o', 'rebuilt.kdr'])).toBe(0)
    expect(documentDifferences(doc, await h.doc('rebuilt.kdr'))).toEqual([])
  })

  it('html --format react / vue で、インスタンスを部品の呼び出しにする', async () => {
    const h = harness({ 'a.xml': LINKED })
    expect(await h.run(['build', 'a.xml', '-o', 'a.kdr'])).toBe(0)
    expect(await h.run(['-f', 'a.kdr', 'html', 'Screen', '--format', 'react'])).toBe(0)
    expect(h.stdout).toContain("import { Button } from '@/ui'\nimport { StarIcon } from '@/icons'")
    expect(h.stdout).toContain('<Button variant="quiet" size="大" showIcon={false}>')
    expect(h.stdout).toContain('やめる')
    expect(h.stdout).toContain('<Button variant="primary" size="大" icon={<StarIcon />} showIcon>')
    expect(h.stdout).not.toContain('class')
    const vue = harness({ 'a.kdr': h.fs.get('a.kdr')! })
    expect(await vue.run(['-f', 'a.kdr', 'html', 'b4', '--format', 'vue'])).toBe(0)
    expect(vue.stdout).toContain(
      ["<script setup>", "import { Button } from '@/ui'", "import { StarIcon } from '@/icons'", '</script>', '', '<template>', '  <Button variant="primary" size="大" showIcon>', '    <template #icon><StarIcon /></template>', '    OK', '  </Button>'].join('\n'),
    )
  })

  it('code と code-prop で対応を書き、バリアントを指せばまとまりに書く。"" と --reset で外す', async () => {
    const h = harness({ 'a.xml': VARIANTS })
    expect(await h.run(['build', 'a.xml', '-o', 'a.kdr'])).toBe(0)
    expect(
      await h.run([
        '-f', 'a.kdr', '-o', 'b.kdr',
        'code', 'large', 'Button', '--from', './Button.vue', '--default',
        '+', 'code-prop', 'buttons', '種類', 'variant', '標準=primary',
        '+', 'code-prop', 'buttons', '大きさ', '',
        '+', 'code', 'icon', 'Icon',
      ]),
    ).toBe(0)
    const doc = await h.doc('b.kdr')
    expect(byName<FrameNode>(doc, 'Button').setCode).toEqual({
      name: 'Button',
      from: './Button.vue',
      defaultExport: true,
      props: [
        { property: '種類', prop: 'variant', values: { 標準: 'primary' } },
        { property: '大きさ', prop: '', values: {} },
      ],
    })
    const icon = byName<FrameNode>(doc, 'Icon')
    expect(icon.component?.role === 'main' && icon.component.code).toMatchObject({ name: 'Icon', from: '' })
    expect(await h.run(['-f', 'b.kdr', '-o', 'c.kdr', 'code-prop', 'buttons', '大きさ', '--reset', '+', 'code', 'icon', ''])).toBe(0)
    const reset = await h.doc('c.kdr')
    expect(byName<FrameNode>(reset, 'Button').setCode?.props.map((prop) => prop.property)).toEqual(['種類'])
    const resetIcon = byName<FrameNode>(reset, 'Icon')
    expect(resetIcon.component?.role === 'main' && resetIcon.component.code).toBe(null)
  })

  it('書き間違いは行を付けて知らせる', async () => {
    const h = harness({
      'a.xml': '<kdr name="x"><page name="p">\n<component name="A" width="10" height="10" code="1A"/>\n</page></kdr>',
      'b.xml': '<kdr name="x"><page name="p">\n<frame name="F" width="10" height="10">\n<code-prop property="a"/>\n</frame>\n</page></kdr>',
      'c.xml': '<kdr name="x"><page name="p">\n<component name="A" width="10" height="10" code-from="x"/>\n</page></kdr>',
    })
    expect(await h.run(['build', 'a.xml', '-o', 'a.kdr'])).not.toBe(0)
    expect(h.stderr).toContain('a.xml:2: code="1A"')
    expect(await h.run(['build', 'b.xml', '-o', 'b.kdr'])).not.toBe(0)
    expect(h.stderr).toContain('b.xml:3: <code-prop> は <component> か <component-set> の中にだけ書けます')
    expect(await h.run(['build', 'c.xml', '-o', 'c.kdr'])).not.toBe(0)
    expect(h.stderr).toContain('c.xml:2: code-from・code-default・<code-prop> を書くときは')
    expect(await h.run(['-f', 'a.kdr', 'code', 'x', 'B'])).not.toBe(0)
    const v = harness({ 'a.xml': VARIANTS })
    expect(await v.run(['build', 'a.xml', '-o', 'a.kdr'])).toBe(0)
    expect(await v.run(['-f', 'a.kdr', 'code', 'buttons', 'Button', '+', 'code-prop', 'buttons', '文言', 'v-html'])).not.toBe(0)
    expect(v.stderr).toContain('v- で始まる名前')
    expect(await v.run(['-f', 'a.kdr', 'code', 'buttons', 'Button', '--from', 'a\nb'])).not.toBe(0)
    expect(v.stderr).toContain('--from に使えない文字')
  })
})
