import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { decodeKdr } from '../src/document/kdr.ts'
import type { DesignDocument, FrameNode, ImageNode, RectNode, SceneNode, TextNode } from '../src/document/types.ts'
import { type IO, run } from './run.ts'

// kdr build / kdr place（マークアップからノードを作る）と、それに合わせて set / add に足した略記

const encode = (text: string) => new TextEncoder().encode(text)

// 2×1 の PNG
const PNG = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEElEQVR42mP8z8Dwn4GBgQEADQMB/2xXUNoAAAAASUVORK5CYII='),
  (c) => c.charCodeAt(0),
)

function harness(files: Record<string, Uint8Array | string> = {}) {
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
    readStdin: async () => new Uint8Array(),
    stdinIsTTY: true,
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
      align: 'start', justify: 'start', wrap: false, crossGap: 0, alignContent: 'auto',
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
    expect(bad.stderr).toMatch(/layout\.gap: 先に layout=row\|column か auto-layout/)
    expect(await bad.run(['new', '+', 'add', 'frame', 'layout=row', 'padding=1 2 3 4 5', '-o', 'b.kdr'])).toBe(2)
    expect(await bad.run(['new', '+', 'add', 'text', 'lineHeight=px', '-o', 'b.kdr'])).toBe(2)
  })
})
