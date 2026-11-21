import { describe, expect, it } from 'vitest'
import { KDR_VERSION, KdrError, decodeKdr, kdrFile, parseKdr } from '../document/kdr.ts'
import { solid } from '../document/paint.ts'
import type { DesignDocument, Page } from '../document/types.ts'
import { encodeKdr } from './exportKdr.ts'
import { pathFromPoints } from '../document/path.ts'
import {
  createEllipse,
  createFrame,
  createImage,
  createLine,
  createPath,
  createRect,
  createText,
} from './nodes.ts'
import { addAsset, createPage, insertNode, removeNodes } from './operations.ts'

function samplePage(): Page {
  const frame = createFrame({ x: 0, y: 0, width: 400, height: 300 })
  let page = createPage('ホーム')
  page = insertNode(page, frame)
  page = insertNode(page, createRect({ x: 10, y: 10, width: 50, height: 50 }), frame.id)
  page = insertNode(page, createText({ x: 10, y: 80, width: 200, height: 20 }, 'こんにちは'), frame.id)
  page = insertNode(page, createEllipse({ x: 500, y: 0, width: 80, height: 80 }))
  return page
}

function documentOf(...pages: Page[]): DesignDocument {
  return { name: 'サンプル', pages, assets: {} }
}

async function gzip(text: string): Promise<Blob> {
  return new Response(new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))).blob()
}

// 1x1 の透明な PNG
const PNG = {
  mime: 'image/png',
  data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
}

type RawNode = Record<string, unknown>

function kdrJson(document: unknown, version: number = KDR_VERSION) {
  return { format: 'kadrokreo', version, document }
}

/** 1 ページだけのファイル。children はページ直下のノード（ファイルの形のまま） */
function kdrOf(children: unknown[], assets: unknown = {}) {
  return kdrJson({ name: 'x', pages: [{ id: 'p1', name: 'Page 1', children }], assets })
}

/** ファイルの形の最小のノード（既定値の項目は省いてある） */
function rawNode(patch: RawNode = {}): RawNode {
  return { type: 'rect', id: 'n1', name: 'Box', x: 0, y: 0, width: 10, height: 10, ...patch }
}

/** 1 つのノードだけのファイルを読み、そのノードを返す */
function parseOne(node: RawNode, assets: unknown = {}) {
  return parseKdr(kdrOf([node], assets)).pages[0].nodes[node.id as string]
}

/** メモリ上のノードを、ファイルの形にする */
function fileNode(page: Page, index = 0): RawNode {
  const file = kdrFile(documentOf(page)) as { document: { pages: { children: RawNode[] }[] } }
  return file.document.pages[0].children[index]
}

describe('kdr', () => {
  it('書き出したファイルを読み込むと同じドキュメントに戻る', async () => {
    const doc = documentOf(samplePage(), createPage('設定'))
    expect(await decodeKdr(await encodeKdr(doc))).toEqual(doc)
  })

  it('実体は gzip 圧縮された 1 つの JSON', async () => {
    const bytes = new Uint8Array(await (await encodeKdr(documentOf(samplePage()))).arrayBuffer())
    expect([...bytes.slice(0, 2)]).toEqual([0x1f, 0x8b])
  })

  it('画像を埋め込んだまま往復し、どのページでも使われていない画像は書き出さない', async () => {
    const first = createImage({ x: 0, y: 0, width: 1, height: 1 }, 'first')
    const second = createImage({ x: 0, y: 0, width: 1, height: 1 }, 'second')
    const unused = createImage({ x: 0, y: 0, width: 1, height: 1 }, 'unused')
    const pageA = removeNodes(insertNode(insertNode(createPage('A'), first), unused), [unused.id])
    const pageB = insertNode(createPage('B'), second)
    let doc = documentOf(pageA, pageB)
    for (const id of ['first', 'second', 'unused']) doc = addAsset(doc, id, PNG)

    const loaded = await decodeKdr(await encodeKdr(doc))
    expect(loaded.assets).toEqual({ first: PNG, second: PNG })
    expect(loaded.pages[1].nodes[second.id]).toEqual(second)
  })

  it('gzip でないファイルは読めない', async () => {
    await expect(decodeKdr(new Blob(['{"format":"kadrokreo"}']))).rejects.toThrow(KdrError)
  })

  it('JSON でない中身は読めない', async () => {
    await expect(decodeKdr(await gzip('not json'))).rejects.toThrow(KdrError)
  })

  it('展開後のサイズが上限を超えるファイルは読めない', async () => {
    const file = await gzip(' '.repeat(1_000_000))
    expect(file.size).toBeLessThan(10_000)
    await expect(decodeKdr(file, { maxBytes: 100_000 })).rejects.toThrow('大きすぎ')
  })
})

describe('kdrFile（書き出す形）', () => {
  it('ノードは入れ子の木で、親の id と子の id の並びは書かない', () => {
    const page = samplePage()
    const frame = fileNode(page)
    expect(frame).not.toHaveProperty('parentId')
    const children = frame.children as RawNode[]
    expect(children.map((child) => child.name)).toEqual(['Rectangle', 'Text'])
    expect(children[0]).not.toHaveProperty('parentId')
    expect(children[0]).not.toHaveProperty('children')
    const file = kdrFile(documentOf(page)) as { document: { pages: RawNode[] } }
    expect(file.document.pages[0]).not.toHaveProperty('rootIds')
    expect(file.document.pages[0]).not.toHaveProperty('nodes')
  })

  it('既定値と同じ項目は書かない', () => {
    const rect = createRect({ x: 1, y: 2, width: 3, height: 4 })
    expect(fileNode(insertNode(createPage(), rect))).toEqual({
      id: rect.id,
      name: 'Rectangle',
      type: 'rect',
      x: 1,
      y: 2,
      width: 3,
      height: 4,
      fills: [{ type: 'solid', color: '#d9d9d9' }],
    })
    // 大きさの決め方は fixed でない向きだけ。テキストの高さは常に中身で決まるので書かない
    const text = createText({ x: 0, y: 0, width: 10, height: 10 }, 'a')
    expect(fileNode(insertNode(createPage(), text))).toMatchObject({ sizing: { width: 'hug' } })
    expect(fileNode(insertNode(createPage(), text)).sizing).not.toHaveProperty('height')
    // オートレイアウトの中も、既定値の項目は書かない
    const frame = {
      ...createFrame({ x: 0, y: 0, width: 10, height: 10 }),
      layout: { direction: 'vertical', gap: 8, paddingTop: 0, paddingRight: 0, paddingBottom: 0, paddingLeft: 0, align: 'start', justify: 'start', wrap: false, crossGap: 0, alignContent: 'auto' },
      sizing: { width: 'hug', height: 'fixed' },
    } as const
    expect(fileNode(insertNode(createPage(), frame))).toMatchObject({ layout: { direction: 'vertical', gap: 8 }, sizing: { width: 'hug' } })
    expect(Object.keys(fileNode(insertNode(createPage(), frame)).layout as object)).toEqual(['direction', 'gap'])
  })

  it('上書きのないインスタンスは overrides を書かない', () => {
    const frame = { ...createFrame({ x: 0, y: 0, width: 10, height: 10 }), component: { id: 'c1', role: 'instance', overrides: {} } } as const
    expect(fileNode(insertNode(createPage(), frame)).component).toEqual({ id: 'c1', role: 'instance' })
    expect(parseOne(fileNode(insertNode(createPage(), frame)))).toEqual(frame)
  })
})

describe('parseKdr', () => {
  it('別形式や、今の version 以外を拒否する', () => {
    const doc = kdrFile(documentOf(samplePage())).document
    expect(() => parseKdr({ format: 'other', version: KDR_VERSION, document: doc })).toThrow(KdrError)
    expect(() => parseKdr(kdrJson(doc, KDR_VERSION + 1))).toThrow('新しいバージョン')
    expect(() => parseKdr(kdrJson(doc, KDR_VERSION - 1))).toThrow('古いバージョン')
    expect(() => parseKdr(kdrJson(doc, 1.5))).toThrow('未対応')
    expect(() => parseKdr(kdrJson(doc, 0))).toThrow('未対応')
    expect(() => parseKdr(null)).toThrow(KdrError)
  })

  it('ページは 1 つ以上あり、id が重複していないこと', () => {
    const page = samplePage()
    const two = kdrFile(documentOf(page, createPage('B')))
    expect(parseKdr(two).pages.map((p) => p.name)).toEqual(['ホーム', 'B'])
    expect(() => parseKdr(kdrFile(documentOf()))).toThrow('ページがありません')
    expect(() => parseKdr(kdrFile(documentOf(page, { ...createPage('B'), id: page.id })))).toThrow('重複')
  })

  it('ノードの id はページごとに独立している。同じページの中では重複を拒否する', () => {
    const page = samplePage()
    expect(parseKdr(kdrFile(documentOf(page, { ...structuredClone(page), id: 'other' }))).pages).toHaveLength(2)
    expect(() => parseKdr(kdrOf([rawNode(), rawNode()]))).toThrow('重複')
    // 子にも同じ id があれば拒否する
    expect(() => parseKdr(kdrOf([rawNode({ type: 'frame', children: [rawNode()] })]))).toThrow('重複')
  })

  it('入れ子から親子を組み立てる', () => {
    const page = parseKdr(kdrOf([rawNode({ type: 'frame', id: 'f', children: [rawNode({ id: 'a' }), rawNode({ id: 'b' })] }), rawNode({ id: 'c' })])).pages[0]
    expect(page.rootIds).toEqual(['f', 'c'])
    expect(page.nodes.f).toMatchObject({ parentId: null, children: ['a', 'b'] })
    expect(page.nodes.b).toMatchObject({ parentId: 'f' })
    // フレームでないノードの children は捨てる
    const rect = parseKdr(kdrOf([rawNode({ children: [rawNode({ id: 'x' })] })])).pages[0]
    expect(Object.keys(rect.nodes)).toEqual(['n1'])
  })

  it('親の辺への追従を検証し、start の向きは書き出しで省く', () => {
    expect(parseOne(rawNode({ constraints: { horizontal: 'end' } }))).toMatchObject({
      constraints: { horizontal: 'end', vertical: 'start' },
    })
    expect(parseOne(rawNode({ constraints: { horizontal: 'stretch', vertical: 'scale' } }))).toMatchObject({
      constraints: { horizontal: 'stretch', vertical: 'scale' },
    })
    expect(() => parseOne(rawNode({ constraints: { vertical: 'bottom' } }))).toThrow('constraints.vertical')
    expect(() => parseOne(rawNode({ constraints: 'end' }))).toThrow('constraints')
    const rect = createRect({ x: 0, y: 0, width: 10, height: 10 })
    expect(fileNode(insertNode(createPage(), rect))).not.toHaveProperty('constraints')
    const centered = { ...rect, constraints: { horizontal: 'center', vertical: 'start' } } as const
    expect(fileNode(insertNode(createPage(), centered))).toMatchObject({ constraints: { horizontal: 'center' } })
    expect(fileNode(insertNode(createPage(), centered)).constraints).toEqual({ horizontal: 'center' })
  })

  it('折り返した行の置き方を検証し、既定値なら書き出しで省く', () => {
    const withLayout = (layout: object) => rawNode({ type: 'frame', layout })
    expect(parseOne(withLayout({ alignContent: 'space-between' }))).toMatchObject({ layout: { alignContent: 'space-between' } })
    expect(() => parseOne(withLayout({ alignContent: 'center' }))).toThrow('layout.alignContent')
  })

  it('省いた項目は既定値で補う', () => {
    expect(parseOne(rawNode())).toEqual({
      id: 'n1',
      name: 'Box',
      type: 'rect',
      parentId: null,
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      rotation: 0,
      visible: true,
      locked: false,
      opacity: 1,
      sizing: { width: 'fixed', height: 'fixed' },
      layoutPositioning: 'auto',
      constraints: { horizontal: 'start', vertical: 'start' },
      minWidth: null,
      maxWidth: null,
      minHeight: null,
      maxHeight: null,
      fills: [],
      strokes: [],
      strokeWidth: 1,
      effects: [],
      cornerRadius: 0,
    })
    expect(parseOne(rawNode({ type: 'text', text: 'a', fontSize: 16, fontFamily: 'serif' }))).toMatchObject({
      fills: [],
      fontWeight: 400,
      textAlign: 'left',
      lineHeight: 1.2,
      sizing: { width: 'fixed', height: 'hug' },
    })
    expect(parseOne(rawNode({ type: 'frame', layout: {} }))).toMatchObject({
      children: [],
      clipContent: true,
      component: null,
      layout: { direction: 'horizontal', gap: 0, paddingTop: 0, align: 'start', justify: 'start', wrap: false, crossGap: 0, alignContent: 'auto' },
    })
  })

  it('塗り・線・効果を検証する', () => {
    const gradient = { type: 'linear', angle: 90, stops: [{ offset: 0, color: '#000000' }, { offset: 1, color: '#ffffff' }] }
    const effect = { type: 'drop-shadow', x: 0, y: 4, blur: 8, color: '#000000', opacity: 0.25 }
    const styled = rawNode({ fills: [{ type: 'solid', color: '#ff0000' }, gradient], strokes: [gradient], strokeWidth: 2, effects: [effect, effect] })
    expect(parseOne(styled)).toMatchObject({ fills: styled.fills, strokes: styled.strokes, effects: styled.effects })

    expect(() => parseOne(rawNode({ fills: [{ type: 'image' }] }))).toThrow('fills[0].type')
    expect(() => parseOne(rawNode({ fills: [{ type: 'solid', color: 'red' }] }))).toThrow('fills[0].color')
    expect(() => parseOne(rawNode({ fills: '#ff0000' }))).toThrow('fills')
    expect(() => parseOne(rawNode({ strokes: [{ ...gradient, stops: [gradient.stops[0]] }] }))).toThrow('色の数')
    expect(() => parseOne(rawNode({ fills: [{ ...gradient, stops: gradient.stops.toReversed() }] }))).toThrow('小さい順')
    expect(() => parseOne(rawNode({ fills: [{ ...gradient, stops: [gradient.stops[0], { offset: 2, color: '#000000' }] }] }))).toThrow(
      'stops[1].offset',
    )
    expect(() => parseOne(rawNode({ effects: [{ ...effect, opacity: 2 }] }))).toThrow('effects[0].opacity')
    expect(() => parseOne(rawNode({ effects: [{ ...effect, type: 'blur' }] }))).toThrow('effects[0].type')
    expect(() => parseOne(rawNode({ fills: Array(17).fill({ type: 'solid', color: '#000000' }) }))).toThrow('多すぎ')
  })

  it('大きさの決め方を検証する。中身に合わせられないノードの hug は拒否する', () => {
    expect(parseOne(rawNode({ sizing: { width: 'fill' } }))).toMatchObject({ sizing: { width: 'fill', height: 'fixed' } })
    expect(() => parseOne(rawNode({ sizing: { width: 'auto' } }))).toThrow('sizing.width')
    expect(() => parseOne(rawNode({ sizing: { height: 'hug' } }))).toThrow('sizing.height')
    // 自動で並べないフレームの hug は固定として読む
    expect(parseOne(rawNode({ type: 'frame', sizing: { width: 'hug' } }))).toMatchObject({ sizing: { width: 'fixed' } })
    expect(parseOne(rawNode({ type: 'frame', layout: {}, sizing: { width: 'hug' } }))).toMatchObject({ sizing: { width: 'hug' } })
    // テキストの高さは常に hug
    const text = rawNode({ type: 'text', text: 'a', fontSize: 16, fontFamily: 'serif', sizing: { width: 'hug', height: 'fixed' } })
    expect(parseOne(text)).toMatchObject({ sizing: { width: 'hug', height: 'hug' } })
  })

  it('大きさの下限・上限と、並びから外す指定を検証する', () => {
    expect(parseOne(rawNode({ minWidth: 20, maxHeight: null }))).toMatchObject({ minWidth: 20, maxHeight: null })
    expect(() => parseOne(rawNode({ minWidth: -1 }))).toThrow('minWidth')
    expect(() => parseOne(rawNode({ maxHeight: '40' }))).toThrow('maxHeight')
    expect(parseOne(rawNode({ layoutPositioning: 'absolute' }))).toMatchObject({ layoutPositioning: 'absolute' })
    expect(() => parseOne(rawNode({ layoutPositioning: 'fixed' }))).toThrow('layoutPositioning')
  })

  it('テキストの太さは 100〜900 の 100 刻み', () => {
    const text = (fontWeight: unknown) => rawNode({ type: 'text', text: 'a', fontSize: 16, fontFamily: 'serif', fontWeight })
    expect(parseOne(text(500))).toMatchObject({ fontWeight: 500 })
    expect(() => parseOne(text(450))).toThrow('fontWeight')
    expect(() => parseOne(text(1000))).toThrow('fontWeight')
  })

  it('パスと直線を検証する', () => {
    const shape = pathFromPoints([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 8 }])
    const path = { ...createPath(shape, true), endCap: 'arrow' as const }
    expect(parseOne(fileNode(insertNode(createPage(), path)))).toEqual(path)
    // 直線は 2 つの頂点の開いたパス。水平なら高さ 0
    const line = createLine(pathFromPoints([{ x: 10, y: 5 }, { x: 0, y: 5 }]))
    expect(line).toMatchObject({ type: 'path', height: 0, points: [{ x: 1, y: 0 }, { x: 0, y: 0 }] })
    expect(parseOne(fileNode(insertNode(createPage(), line)))).toEqual(line)

    const raw = (patch: RawNode) => rawNode({ type: 'path', points: [{ x: 0, y: 0 }, { x: 1, y: 1 }], ...patch })
    expect(() => parseOne(raw({ points: [{ x: 0, y: 0 }] }))).toThrow('頂点')
    expect(() => parseOne(raw({ points: [{ x: 0, y: 0 }, { x: '1', y: 0 }] }))).toThrow('points[1].x')
    expect(() => parseOne(raw({ points: 'M0 0L1 1' }))).toThrow('points')
    expect(() => parseOne(raw({ endCap: 'circle' }))).toThrow('endCap')
  })

  it('パスの頂点の制御点 in / out を検証する。省けば角の頂点で、書き出しでも書かない', () => {
    const shape = pathFromPoints([
      { x: 0, y: 0, out: { x: 0, y: -40 } },
      { x: 100, y: 0, in: { x: 100, y: -40 }, out: { x: 120, y: 20 } },
      { x: 100, y: 50 },
    ])
    const path = createPath(shape, false)
    const file = fileNode(insertNode(createPage(), path))
    expect(Object.keys((file.points as RawNode[])[2])).toEqual(['x', 'y'])
    expect((file.points as RawNode[])[0]).toHaveProperty('out')
    expect((file.points as RawNode[])[0]).not.toHaveProperty('in')
    expect(parseOne(file)).toEqual(path)

    const raw = (points: unknown) => rawNode({ type: 'path', points })
    // 制御点は枠の外に出てよい（枠は曲線そのものを囲むため）
    expect(parseOne(raw([{ x: 0, y: 1, out: { x: 0, y: -1.5 } }, { x: 1, y: 1, in: { x: 0, y: -1.5 } }]))).toMatchObject({
      points: [{ x: 0, y: 1, out: { x: 0, y: -1.5 } }, { x: 1, y: 1, in: { x: 0, y: -1.5 } }],
    })
    expect(parseOne(raw([{ x: 0, y: 0 }, { x: 1, y: 1 }]))).not.toHaveProperty('points.0.in')
    expect(() => parseOne(raw([{ x: 0, y: 0, in: { x: 'a', y: 0 } }, { x: 1, y: 1 }]))).toThrow('points[0].in.x')
    expect(() => parseOne(raw([{ x: 0, y: 0 }, { x: 1, y: 1, out: [0, 1] }]))).toThrow('points[1].out')
  })

  it('オートレイアウトの設定を検証する', () => {
    const layout = {
      direction: 'vertical',
      gap: 8,
      paddingTop: 12,
      paddingRight: 16,
      paddingBottom: 4,
      paddingLeft: 0,
      align: 'center',
      justify: 'space-between',
      wrap: true,
      crossGap: 6, alignContent: 'auto',
    }
    expect(parseOne(rawNode({ type: 'frame', layout }))).toMatchObject({ layout })
    const withLayout = (patch: object) => rawNode({ type: 'frame', layout: { ...layout, ...patch } })
    expect(() => parseOne(withLayout({ direction: 'diagonal' }))).toThrow('layout.direction')
    expect(() => parseOne(withLayout({ paddingLeft: -1 }))).toThrow('layout.paddingLeft')
    expect(() => parseOne(withLayout({ gap: '8' }))).toThrow('layout.gap')
    expect(() => parseOne(withLayout({ wrap: 'yes' }))).toThrow('layout.wrap')
    expect(() => parseOne(withLayout({ crossGap: null }))).toThrow('layout.crossGap')
  })

  it('コンポーネントとのつながりを検証する', () => {
    const main = rawNode({ type: 'frame', component: { id: 'c1', role: 'main' } })
    expect(parseOne(main)).toMatchObject({ component: { id: 'c1', role: 'main' } })
    expect(parseOne(main)).not.toHaveProperty('component.overrides')
    expect(() => parseOne(rawNode({ type: 'frame', component: { id: 'c1', role: 'copy' } }))).toThrow('component.role')
    expect(() => parseOne(rawNode({ type: 'frame', component: { id: '../x', role: 'main' } }))).toThrow('component.id')
  })

  it('インスタンスごとの上書きを検証する', () => {
    const withOverrides = (overrides: unknown) => rawNode({ type: 'frame', component: { id: 'c1', role: 'instance', overrides } })
    const overrides = {
      n1: { text: '送信', fills: solid('#ff0000'), visible: false },
      n2: { fills: [], strokes: [] },
      n3: { fills: [{ type: 'linear', angle: 90, stops: [{ offset: 0, color: '#000000' }, { offset: 1, color: '#ffffff' }] }] },
      n4: { fontSize: 24, fontFamily: 'serif', fontWeight: 700 },
    }
    expect(parseOne(withOverrides(overrides))).toMatchObject({ component: { id: 'c1', role: 'instance', overrides } })
    // 知らない項目は捨てる。省けば上書きなし
    const loaded = parseOne(withOverrides({ n1: { text: 'a', width: 999 } }))
    expect(loaded).toMatchObject({ component: { overrides: { n1: { text: 'a' } } } })
    expect(loaded).not.toHaveProperty('component.overrides.n1.width')
    expect(parseOne(withOverrides(undefined))).toMatchObject({ component: { overrides: {} } })

    expect(() => parseOne(withOverrides({ n1: { fills: '#ff0000' } }))).toThrow('overrides.n1.fills')
    expect(() => parseOne(withOverrides({ n1: { strokes: [{ type: 'solid', color: 'red' }] } }))).toThrow('overrides.n1.strokes')
    expect(() => parseOne(withOverrides({ n1: { text: 1 } }))).toThrow('overrides.n1.text')
    expect(() => parseOne(withOverrides({ n1: { fontWeight: 450 } }))).toThrow('overrides.n1.fontWeight')
    expect(() => parseOne(withOverrides({ n1: { assetId: 'nothing' } }))).toThrow('上書きの画像データがありません')
    expect(() => parseOne(withOverrides({ n1: { visible: 'no' } }))).toThrow('overrides.n1.visible')
    // 入れ子のインスタンスの差し替え。差し替え先のコンポーネントは、ファイルになくても読める（同期で無視される）
    expect(parseOne(withOverrides({ n1: { componentId: 'c9' } }))).toMatchObject({ component: { overrides: { n1: { componentId: 'c9' } } } })
    expect(() => parseOne(withOverrides({ n1: { componentId: 3 } }))).toThrow('overrides.n1.componentId')
    expect(() => parseOne(withOverrides({ n1: { componentId: '__proto__' } }))).toThrow('overrides.n1.componentId')
    expect(() => parseOne(withOverrides({ '../x': {} }))).toThrow('不正な id')
    expect(() => parseOne(withOverrides([]))).toThrow('component.overrides')
    // 画像の差し替えは、ファイルの中の画像を指していればよい
    expect(parseOne(withOverrides({ n1: { assetId: 'a1' } }), { a1: PNG })).toMatchObject({ component: { overrides: { n1: { assetId: 'a1' } } } })
  })

  it('画像は対応形式の base64 で、データが揃っているものだけ受け付ける', () => {
    const image = rawNode({ type: 'image', assetId: 'a1' })
    expect(parseKdr(kdrOf([image], { a1: PNG })).assets).toEqual({ a1: PNG })
    expect(parseOne(image, { a1: PNG })).toMatchObject({ fit: 'cover', cornerRadius: 0 })
    expect(() => parseOne(image, {})).toThrow('画像データ')
    expect(() => parseOne(image, { a1: { ...PNG, mime: 'image/svg+xml' } })).toThrow('画像形式')
    expect(() => parseOne(image, { a1: { ...PNG, data: '<svg onload=alert(1)>' } })).toThrow('base64')
  })

  it('知らないフィールドは捨てる', () => {
    expect(parseOne(rawNode({ onclick: 'alert(1)' }))).not.toHaveProperty('onclick')
  })

  it('型の合わないフィールドを拒否する', () => {
    expect(() => parseOne(rawNode({ width: '400' }))).toThrow('width')
    expect(() => parseOne(rawNode({ type: 'line' }))).toThrow('type')
    expect(() => parseOne(rawNode({ visible: 1 }))).toThrow('visible')
  })

  it('深すぎる入れ子を拒否する', () => {
    let node = rawNode({ type: 'frame', id: 'n100' })
    for (let i = 99; i >= 0; i--) node = rawNode({ type: 'frame', id: `n${i}`, children: [node] })
    expect(() => parseKdr(kdrOf([node]))).toThrow('深すぎ')
  })

  it('Object.prototype のプロパティ名を id として通さない', () => {
    expect(() => parseOne(rawNode({ id: '__proto__' }))).toThrow(KdrError)
    expect(() => parseOne(rawNode({ id: '../x' }))).toThrow('不正な id')
  })
})
