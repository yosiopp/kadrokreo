import { describe, expect, it } from 'vitest'
import { KDR_VERSION, KdrError, MAX_FONT_FAMILY_LENGTH, decodeKdr, kdrFile, parseKdr } from '../document/kdr.ts'
import { solid } from '../document/paint.ts'
import type { DesignDocument, Page } from '../document/types.ts'
import { encodeKdr, kdrEntries } from './exportKdr.ts'
import { fromBase64, gzipBlob, kdrBlob, pngHeader, tarGz } from '../document/testKdr.ts'
import { sha256Hex } from '../document/sha256.ts'
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
import { addAsset, addOrReuseAsset, createPage, updatePage } from './operations/document.ts'
import { insertNode, removeNodes } from './operations/tree.ts'

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

// 1x1 の透明な PNG
const PNG = {
  mime: 'image/png',
  bytes: fromBase64('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='),
}

type RawNode = Record<string, unknown>

function kdrJson(document: unknown, version: number = KDR_VERSION) {
  return { format: 'kadrokreo', version, document }
}

/** 1 ページだけのファイル。children はページ直下のノード（ファイルの形のまま） */
function kdrOf(children: unknown[]) {
  return kdrJson({ name: 'x', pages: [{ id: 'p1', name: 'Page 1', children }] })
}

/** ファイルの形の最小のノード（既定値の項目は省いてある） */
function rawNode(patch: RawNode = {}): RawNode {
  return { type: 'rect', id: 'n1', name: 'Box', x: 0, y: 0, width: 10, height: 10, ...patch }
}

/** 1 つのノードだけのファイルを読み、そのノードを返す */
function parseOne(node: RawNode, assets: Record<string, unknown> = {}) {
  return parseKdr(kdrOf([node]), assets).pages[0].nodes[node.id as string]
}

/** メモリ上のノードを、ファイルの形にする */
function fileNode(page: Page, index = 0): RawNode {
  const file = kdrFile(documentOf(page)) as { document: { pages: { children: RawNode[] }[] } }
  return file.document.pages[0].children[index]
}

/** ファイルの形のノード 1 つを読んで、書き出し直した形 */
function roundTrip(node: RawNode, assets: Parameters<typeof parseKdr>[1] = {}): RawNode {
  return fileNode(parseKdr(kdrOf([node]), assets).pages[0])
}

describe('kdr', () => {
  it('書き出したファイルを読み込むと同じドキュメントに戻る', async () => {
    const doc = documentOf(samplePage(), createPage('設定'))
    expect(await decodeKdr(await encodeKdr(doc))).toEqual(doc)
  })

  it('実体は tar を gzip で圧縮した 1 つのファイルで、document.json と assets/<sha256>.<拡張子> が入る', async () => {
    const image = createImage({ x: 0, y: 0, width: 1, height: 1 }, 'x')
    const { document, assetId } = addOrReuseAsset(documentOf(createPage('A')), PNG, () => 'unused')
    const doc = updatePage(document, document.pages[0].id, (page) => insertNode(page, { ...image, assetId }))
    expect(assetId).toBe(sha256Hex(PNG.bytes))
    const blob = await encodeKdr(doc)
    const bytes = new Uint8Array(await blob.arrayBuffer())
    expect([...bytes.slice(0, 2)]).toEqual([0x1f, 0x8b])
    const tar = new Uint8Array(await new Response(blob.stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer())
    expect(new TextDecoder().decode(tar.slice(0, 13))).toBe('document.json')
    expect(new TextDecoder().decode(tar.slice(257, 262))).toBe('ustar')
    expect(kdrEntries(doc).map((entry) => entry.name)).toEqual(['document.json', `assets/${assetId}.png`])
    // document.json には画像のデータを入れない
    expect(JSON.parse(new TextDecoder().decode(kdrEntries(doc)[0].bytes))).toEqual(kdrFile(doc))
    // 同じドキュメントなら同じバイト列（時刻などを入れない）
    expect(new Uint8Array(await (await encodeKdr(doc)).arrayBuffer())).toEqual(bytes)
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
    await expect(decodeKdr(new Blob(['{"format":"kadrokreo"}']))).rejects.toThrow('gzip')
  })

  it('tar でない中身（v15 までの gzip した JSON など）は読めない', async () => {
    const json = JSON.stringify(kdrJson({ name: 'x', pages: [{ id: 'p1', name: 'P', children: [] }], assets: {} }))
    await expect(decodeKdr(await gzipBlob(json))).rejects.toThrow(KdrError)
  })

  it('document.json が JSON でなければ読めない', async () => {
    await expect(decodeKdr(await kdrBlob('not json'))).rejects.toThrow('JSON')
  })

  it('展開後のサイズ・document.json・画像 1 枚が上限を超えるファイルは読めない', async () => {
    const file = await kdrBlob(' '.repeat(1_000_000))
    expect(file.size).toBeLessThan(10_000)
    await expect(decodeKdr(file, { maxBytes: 100_000 })).rejects.toThrow('大きすぎ')
    await expect(decodeKdr(file, { maxJsonBytes: 100_000 })).rejects.toThrow('document.json が大きすぎ')
    const image = rawNode({ type: 'image', assetId: 'a1' })
    const big = await kdrBlob(kdrOf([image]), { a1: { mime: 'image/png', bytes: new Uint8Array(200_000) } })
    await expect(decodeKdr(big, { maxAssetBytes: 100_000 })).rejects.toThrow('画像が大きすぎ')
    expect((await decodeKdr(big)).assets.a1.bytes).toHaveLength(200_000)
  })

  it('決まった名前のファイルだけを受け付け、同じ名前や同じ id が 2 つあれば読めない', async () => {
    const json = JSON.stringify(kdrOf([rawNode({ type: 'image', assetId: 'a1' })]))
    const png = PNG.bytes
    const ok = await tarGz([{ name: 'document.json', bytes: json }, { name: 'assets/a1.png', bytes: png }])
    expect((await decodeKdr(ok)).assets).toEqual({ a1: PNG })
    const cases: [{ name: string; bytes: Uint8Array<ArrayBuffer> | string }[], string][] = [
      [[{ name: 'assets/a1.png', bytes: png }], 'document.json がありません'],
      [[{ name: 'document.json', bytes: json }, { name: 'document.json', bytes: json }], '同じ名前'],
      [[{ name: 'document.json', bytes: json }, { name: 'assets/a1.png', bytes: png }, { name: 'assets/a1.jpg', bytes: png }], '同じ id'],
      [[{ name: 'document.json', bytes: json }, { name: 'assets/a1.svg', bytes: '<svg/>' }], '知らないファイル'],
      [[{ name: 'document.json', bytes: json }, { name: '../assets/a1.png', bytes: png }], '知らないファイル'],
      [[{ name: 'document.json', bytes: json }, { name: 'assets/../a1.png', bytes: png }], '知らないファイル'],
      [[{ name: 'document.json', bytes: json }, { name: '/etc/passwd', bytes: png }], '知らないファイル'],
      [[{ name: './document.json', bytes: json }], '知らないファイル'],
      [[{ name: 'document.json', bytes: json }, { name: 'assets/__proto__.png', bytes: png }], '知らないファイル'],
      [[{ name: 'document.json', bytes: json }], '画像データがありません'],
    ]
    for (const [entries, message] of cases) await expect(decodeKdr(await tarGz(entries))).rejects.toThrow(message)
  })

  it('どこからも使われていない画像は読み込みで捨てる', async () => {
    const file = await kdrBlob(kdrOf([rawNode({ type: 'image', assetId: 'a1' })]), { a1: PNG, a2: PNG })
    expect(Object.keys((await decodeKdr(file)).assets)).toEqual(['a1'])
  })

  it('画像が上限を超えるドキュメントは書き出さない', async () => {
    const image = createImage({ x: 0, y: 0, width: 1, height: 1 }, 'big')
    const doc = addAsset(documentOf(insertNode(createPage('A'), image)), 'big', { mime: 'image/png', bytes: new Uint8Array(33 * 1024 * 1024) })
    await expect(encodeKdr(doc)).rejects.toThrow('書き出せません')
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
      blendMode: 'normal',
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
      strokeDashes: [],
      strokeDashOffset: 0,
      strokeJoin: 'miter',
      effects: [],
      cornerRadius: 0,
      isMask: false,
      maskType: 'vector',
    })
    expect(parseOne(rawNode({ type: 'text', text: 'a', fontSize: 16, fontFamily: 'serif' }))).toMatchObject({
      fills: [],
      fontWeight: 400,
      textAlign: 'left',
      lineHeight: 1.2,
      flipX: false,
      flipY: false,
      sizing: { width: 'fixed', height: 'hug' },
    })
    expect(parseOne(rawNode({ type: 'frame', layout: {} }))).toMatchObject({
      children: [],
      clipContent: true,
      passThrough: false,
      component: null,
      setDescription: '',
      booleanOperation: null,
      layout: { direction: 'horizontal', gap: 0, paddingTop: 0, align: 'start', justify: 'start', wrap: false, crossGap: 0, alignContent: 'auto' },
    })
  })

  it('塗り・線・効果を検証する', () => {
    const gradient = { type: 'linear', x1: 0.5, y1: 0, x2: 0.5, y2: 1, stops: [{ offset: 0, color: '#000000' }, { offset: 1, color: '#ffffff' }], opacity: 1 }
    const effect = { type: 'drop-shadow', x: 0, y: 4, blur: 8, color: '#000000', opacity: 0.25 }
    const styled = rawNode({ fills: [{ type: 'solid', color: '#ff0000', opacity: 1 }, gradient], strokes: [gradient], strokeWidth: 2, effects: [effect, effect] })
    expect(parseOne(styled)).toMatchObject({ fills: styled.fills, strokes: styled.strokes, effects: styled.effects })

    expect(() => parseOne(rawNode({ fills: [{ type: 'image' }] }))).toThrow('fills[0].type')
    expect(() => parseOne(rawNode({ fills: [{ type: 'solid', color: 'red', opacity: 1 }] }))).toThrow('fills[0].color')
    expect(() => parseOne(rawNode({ fills: '#ff0000' }))).toThrow('fills')
    expect(() => parseOne(rawNode({ strokes: [{ ...gradient, stops: [gradient.stops[0]] }] }))).toThrow('色の数')
    expect(() => parseOne(rawNode({ fills: [{ ...gradient, stops: gradient.stops.toReversed() }] }))).toThrow('小さい順')
    expect(() => parseOne(rawNode({ fills: [{ ...gradient, stops: [gradient.stops[0], { offset: 2, color: '#000000' }] }] }))).toThrow(
      'stops[1].offset',
    )
    expect(() => parseOne(rawNode({ effects: [{ ...effect, opacity: 2 }] }))).toThrow('effects[0].opacity')
    expect(() => parseOne(rawNode({ effects: [{ ...effect, type: 'blur' }] }))).toThrow('effects[0].type')
    expect(() => parseOne(rawNode({ fills: Array(17).fill({ type: 'solid', color: '#000000', opacity: 1 }) }))).toThrow('多すぎ')
  })

  it('円形のグラデーションを検証する', () => {
    const stops = [{ offset: 0, color: '#000000' }, { offset: 0.4, color: '#ff0000' }, { offset: 1, color: '#ffffff' }]
    const radial = { type: 'radial', cx: 0.5, cy: -0.25, rx: 0.5, ry: 1.5, stops }
    expect(parseOne(rawNode({ fills: [radial], strokes: [radial] }))).toMatchObject({ fills: [radial], strokes: [radial] })
    expect(() => parseOne(rawNode({ fills: [{ ...radial, rx: -1 }] }))).toThrow('fills[0].rx')
    expect(() => parseOne(rawNode({ fills: [{ ...radial, cy: 'top' }] }))).toThrow('fills[0].cy')
    expect(() => parseOne(rawNode({ fills: [{ type: 'radial', cx: 0.5, cy: 0.5, ry: 0.5, stops }] }))).toThrow('fills[0].rx')
    // 書き出しても形は変わらない
    expect(roundTrip(rawNode({ fills: [radial] }))).toMatchObject({ fills: [radial] })
  })

  it('塗りごとの不透明度を検証する。省くと 1 で、1 なら書き出しで省く', () => {
    const red = { type: 'solid', color: '#ff0000' }
    const linear = { type: 'linear', x1: 0, y1: 0.5, x2: 1, y2: 0.5, stops: [{ offset: 0, color: '#000000' }, { offset: 1, color: '#ffffff' }] }
    expect(parseOne(rawNode({ fills: [red] }))).toMatchObject({ fills: [{ ...red, opacity: 1 }] })
    expect(parseOne(rawNode({ fills: [{ ...red, opacity: 0.4 }], strokes: [{ ...linear, opacity: 0 }] }))).toMatchObject({
      fills: [{ opacity: 0.4 }],
      strokes: [{ opacity: 0 }],
    })
    expect(() => parseOne(rawNode({ fills: [{ ...red, opacity: 1.5 }] }))).toThrow('fills[0].opacity')
    expect(() => parseOne(rawNode({ strokes: [{ ...linear, opacity: '50%' }] }))).toThrow('strokes[0].opacity')
    expect(roundTrip(rawNode({ fills: [{ ...red, opacity: 1 }, { ...linear, opacity: 0.5 }] })).fills).toEqual([red, { ...linear, opacity: 0.5 }])
  })

  it('円形のグラデーションの焦点を検証する。省くと中心（0 / 0）で、中心なら書き出しで省く', () => {
    const stops = [{ offset: 0, color: '#000000' }, { offset: 1, color: '#ffffff' }]
    const radial = { type: 'radial', cx: 0.5, cy: 0.5, rx: 0.5, ry: 0.25, stops }
    expect(parseOne(rawNode({ fills: [radial] }))).toMatchObject({ fills: [{ fx: 0, fy: 0 }] })
    expect(parseOne(rawNode({ fills: [{ ...radial, fx: -0.6, fy: 0.8 }] }))).toMatchObject({ fills: [{ fx: -0.6, fy: 0.8 }] })
    expect(() => parseOne(rawNode({ fills: [{ ...radial, fx: 0.8, fy: 0.8 }] }))).toThrow('fills[0].fx')
    expect(() => parseOne(rawNode({ strokes: [{ ...radial, fy: 'top' }] }))).toThrow('strokes[0].fy')
    expect(roundTrip(rawNode({ fills: [{ ...radial, fx: 0, fy: 0 }] })).fills).toEqual([radial])
    expect(roundTrip(rawNode({ fills: [{ ...radial, fx: 0.5, fy: 0 }] })).fills).toEqual([{ ...radial, fx: 0.5, fy: 0 }])
  })

  it('グラデーションの色ごとの不透明度を検証する。省くと 1 で、1 なら書き出しで省く', () => {
    const linear = (stops: unknown[]) => ({ type: 'linear', x1: 0, y1: 0.5, x2: 1, y2: 0.5, stops })
    const clear = linear([{ offset: 0, color: '#ff0000' }, { offset: 1, color: '#ff0000', opacity: 0 }])
    expect(parseOne(rawNode({ fills: [clear] }))).toMatchObject({
      fills: [{ stops: [{ offset: 0, color: '#ff0000', opacity: 1 }, { offset: 1, color: '#ff0000', opacity: 0 }] }],
    })
    expect(() => parseOne(rawNode({ fills: [linear([{ offset: 0, color: '#000000', opacity: 1.2 }, { offset: 1, color: '#000000' }])] }))).toThrow(
      'fills[0].stops[0].opacity',
    )
    expect(() => parseOne(rawNode({ strokes: [linear([{ offset: 0, color: '#000000' }, { offset: 1, color: '#000000', opacity: '0' }])] }))).toThrow(
      'strokes[0].stops[1].opacity',
    )
    // 1 は省き、それ以外は残す
    expect(roundTrip(rawNode({ fills: [linear([{ offset: 0, color: '#ff0000', opacity: 1 }, { offset: 1, color: '#ff0000', opacity: 0.25 }])] })).fills).toEqual([
      linear([{ offset: 0, color: '#ff0000' }, { offset: 1, color: '#ff0000', opacity: 0.25 }]),
    ])
  })

  it('角度のグラデーションを検証する', () => {
    const stops = [{ offset: 0, color: '#000000' }, { offset: 0.5, color: '#ff0000' }, { offset: 1, color: '#000000' }]
    const conic = { type: 'conic', cx: 0.25, cy: 1.5, angle: -45, stops }
    expect(parseOne(rawNode({ fills: [conic], strokes: [conic] }))).toMatchObject({ fills: [conic], strokes: [conic] })
    expect(() => parseOne(rawNode({ fills: [{ ...conic, angle: '90deg' }] }))).toThrow('fills[0].angle')
    expect(() => parseOne(rawNode({ fills: [{ type: 'conic', cy: 0.5, angle: 0, stops }] }))).toThrow('fills[0].cx')
    expect(roundTrip(rawNode({ fills: [conic] })).fills).toEqual([conic])
  })

  it('塗り・効果ごとの表示を検証する。省くと表示で、表示なら書き出しで省く', () => {
    const red = { type: 'solid', color: '#ff0000' }
    const shadow = { type: 'drop-shadow', x: 0, y: 4, blur: 8, color: '#000000', opacity: 0.25 }
    expect(parseOne(rawNode({ fills: [red], effects: [shadow] }))).toMatchObject({ fills: [{ visible: true }], effects: [{ visible: true }] })
    expect(parseOne(rawNode({ fills: [{ ...red, visible: false }], effects: [{ ...shadow, visible: false }] }))).toMatchObject({
      fills: [{ visible: false }],
      effects: [{ visible: false }],
    })
    expect(() => parseOne(rawNode({ fills: [{ ...red, visible: 'no' }] }))).toThrow('fills[0].visible')
    expect(() => parseOne(rawNode({ effects: [{ ...shadow, visible: 0 }] }))).toThrow('effects[0].visible')
    const back = roundTrip(rawNode({ fills: [red, { ...red, visible: false }], effects: [shadow, { ...shadow, visible: false }] }))
    expect(back.fills).toEqual([red, { ...red, visible: false }])
    expect(back.effects).toEqual([shadow, { ...shadow, visible: false }])
  })

  it('内側の影を検証する', () => {
    const inner = { type: 'inner-shadow', x: 2, y: -2, blur: 4, color: '#112233', opacity: 0.5 }
    expect(parseOne(rawNode({ effects: [inner] }))).toMatchObject({ effects: [{ ...inner, visible: true }] })
    expect(roundTrip(rawNode({ effects: [inner] })).effects).toEqual([inner])
  })

  it('描画モード（ノード・塗り）を検証する。normal なら省き、書き出しでも省く', () => {
    const red = { type: 'solid', color: '#ff0000' }
    const node = parseOne(rawNode({ blendMode: 'multiply', fills: [{ ...red, blendMode: 'screen' }, red] }))
    expect(node).toMatchObject({ blendMode: 'multiply', fills: [{ blendMode: 'screen' }, { blendMode: 'normal' }] })
    expect(parseOne(rawNode())).toMatchObject({ blendMode: 'normal' })
    expect(() => parseOne(rawNode({ blendMode: 'add' }))).toThrow('blendMode')
    expect(() => parseOne(rawNode({ fills: [{ ...red, blendMode: 'plus' }] }))).toThrow('fills[0].blendMode')
    const back = roundTrip(rawNode({ blendMode: 'luminosity', fills: [{ ...red, blendMode: 'normal' }, { ...red, blendMode: 'overlay' }] }))
    expect(back).toMatchObject({ blendMode: 'luminosity', fills: [red, { ...red, blendMode: 'overlay' }] })
    expect(roundTrip(rawNode({ blendMode: 'normal' }))).not.toHaveProperty('blendMode')
  })

  it('円形のグラデーションの回す角度を検証する。0 なら省く', () => {
    const stops = [{ offset: 0, color: '#000000' }, { offset: 1, color: '#ffffff' }]
    const radial = { type: 'radial', cx: 0.5, cy: 0.5, rx: 0.5, ry: 0.25, stops }
    expect(parseOne(rawNode({ fills: [radial] }))).toMatchObject({ fills: [{ angle: 0 }] })
    expect(parseOne(rawNode({ fills: [{ ...radial, angle: 30 }] }))).toMatchObject({ fills: [{ angle: 30 }] })
    expect(() => parseOne(rawNode({ fills: [{ ...radial, angle: 'x' }] }))).toThrow('fills[0].angle')
    expect(roundTrip(rawNode({ fills: [{ ...radial, angle: 0 }] })).fills).toEqual([radial])
    expect(roundTrip(rawNode({ fills: [{ ...radial, angle: -45 }] })).fills).toEqual([{ ...radial, angle: -45 }])
  })

  it('影の広がりと、ぼかしの効果を検証する。テキストと画像も効果を持つ', () => {
    const shadow = { type: 'drop-shadow', x: 0, y: 4, blur: 8, color: '#000000', opacity: 0.25 }
    expect(parseOne(rawNode({ effects: [shadow] }))).toMatchObject({ effects: [{ spread: 0 }] })
    expect(parseOne(rawNode({ effects: [{ ...shadow, spread: -2 }] }))).toMatchObject({ effects: [{ spread: -2 }] })
    expect(() => parseOne(rawNode({ effects: [{ ...shadow, spread: '1' }] }))).toThrow('effects[0].spread')
    expect(roundTrip(rawNode({ effects: [{ ...shadow, spread: 0 }] })).effects).toEqual([shadow])
    expect(roundTrip(rawNode({ effects: [{ ...shadow, spread: 3 }] })).effects).toEqual([{ ...shadow, spread: 3 }])
    // 影の描画モード。normal なら書かない
    expect(parseOne(rawNode({ effects: [shadow] }))).toMatchObject({ effects: [{ blendMode: 'normal' }] })
    expect(() => parseOne(rawNode({ effects: [{ ...shadow, blendMode: 'add' }] }))).toThrow('effects[0].blendMode')
    expect(roundTrip(rawNode({ effects: [{ ...shadow, blendMode: 'normal' }] })).effects).toEqual([shadow])
    expect(roundTrip(rawNode({ effects: [{ ...shadow, blendMode: 'multiply' }] })).effects).toEqual([{ ...shadow, blendMode: 'multiply' }])

    const blurs = [{ type: 'layer-blur', blur: 4 }, { type: 'background-blur', blur: 12, visible: false }]
    // ぼかしは影の項目（ずれ・色）を持たない。余計な項目は捨てる
    expect(parseOne(rawNode({ effects: [{ ...blurs[0], x: 3, color: '#ff0000' }, blurs[1]] }))).toMatchObject({
      effects: [{ type: 'layer-blur', blur: 4, visible: true }, { type: 'background-blur', blur: 12, visible: false }],
    })
    expect(parseOne(rawNode({ effects: [blurs[0]] })).effects[0]).not.toHaveProperty('x')
    expect(() => parseOne(rawNode({ effects: [{ type: 'layer-blur' }] }))).toThrow('effects[0].blur')
    expect(() => parseOne(rawNode({ effects: [{ type: 'motion-blur', blur: 1 }] }))).toThrow('effects[0].type')
    expect(roundTrip(rawNode({ effects: blurs })).effects).toEqual(blurs)

    const text = rawNode({ type: 'text', text: 'a', fontSize: 16, fontFamily: 'serif', effects: [shadow] })
    expect(parseOne(text)).toMatchObject({ effects: [{ type: 'drop-shadow' }] })
    expect(parseOne(rawNode({ type: 'text', text: 'a', fontSize: 16, fontFamily: 'serif' }))).toMatchObject({ effects: [] })
    expect(parseOne(rawNode({ type: 'image', assetId: 'a1', effects: [blurs[0]] }), { a1: PNG })).toMatchObject({
      effects: [{ type: 'layer-blur' }],
    })
  })

  it('角丸は数値か 4 隅の配列。0 なら書き出しで省く', () => {
    expect(parseOne(rawNode({ cornerRadius: [1, 2, 3, 4] }))).toMatchObject({ cornerRadius: [1, 2, 3, 4] })
    expect(parseOne(rawNode({ cornerRadius: 8 }))).toMatchObject({ cornerRadius: 8 })
    expect(() => parseOne(rawNode({ cornerRadius: [1, 2, 3] }))).toThrow('4 隅')
    expect(() => parseOne(rawNode({ cornerRadius: [1, 2, -3, 4] }))).toThrow('cornerRadius[2]')
    expect(roundTrip(rawNode({ cornerRadius: [0, 8, 0, 8] }))).toMatchObject({ cornerRadius: [0, 8, 0, 8] })
    expect(roundTrip(rawNode({}))).not.toHaveProperty('cornerRadius')
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

  it('破線と、パスの 2 つ目以降の輪郭・塗る範囲の決め方を検証する', () => {
    expect(parseOne(rawNode({ strokeDashes: [4, 2] }))).toMatchObject({ strokeDashes: [4, 2] })
    expect(() => parseOne(rawNode({ strokeDashes: [-1] }))).toThrow('strokeDashes[0]')
    expect(() => parseOne(rawNode({ strokeDashes: [0, 0] }))).toThrow('strokeDashes')
    expect(() => parseOne(rawNode({ strokeDashes: Array(17).fill(1) }))).toThrow('strokeDashes')
    // 破線のずれ（負も可）と線の角の形
    expect(parseOne(rawNode({ strokeDashes: [4, 2], strokeDashOffset: -3, strokeJoin: 'round' }))).toMatchObject({ strokeDashOffset: -3, strokeJoin: 'round' })
    expect(() => parseOne(rawNode({ strokeDashOffset: '1' }))).toThrow('strokeDashOffset')
    expect(() => parseOne(rawNode({ strokeJoin: 'miter-clip' }))).toThrow('strokeJoin')
    expect(fileNode(insertNode(createPage('p'), createRect({ x: 0, y: 0, width: 10, height: 10 })))).not.toHaveProperty('strokeJoin')
    const joined = { ...createRect({ x: 0, y: 0, width: 10, height: 10 }), strokeDashes: [2, 1], strokeDashOffset: 1, strokeJoin: 'bevel' as const }
    expect(fileNode(insertNode(createPage('p'), joined))).toMatchObject({ strokeDashOffset: 1, strokeJoin: 'bevel' })
    const path = (patch: RawNode = {}) =>
      rawNode({ type: 'path', points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }], closed: true, ...patch })
    expect(parseOne(path())).toMatchObject({ contours: [], fillRule: 'nonzero' })
    const hole = { points: [{ x: 0.2, y: 0.2 }, { x: 0.8, y: 0.2, in: { x: 0, y: 0.1 } }], closed: true }
    expect(parseOne(path({ contours: [hole], fillRule: 'evenodd' }))).toMatchObject({ contours: [hole], fillRule: 'evenodd' })
    // closed は省くと開いた輪郭
    expect(parseOne(path({ contours: [{ points: hole.points }] }))).toMatchObject({ contours: [{ points: hole.points, closed: false }] })
    expect(() => parseOne(path({ fillRule: 'odd' }))).toThrow('fillRule')
    expect(() => parseOne(path({ contours: [{ points: [{ x: 0, y: 0 }] }] }))).toThrow('contours[0].points')
    expect(() => parseOne(path({ contours: [{ points: [{ x: 0, y: 'a' }, { x: 1, y: 1 }] }] }))).toThrow('contours[0].points[0].y')
    expect(() => parseOne(path({ contours: [{ points: hole.points, closed: 1 }] }))).toThrow('contours[0].closed')
  })

  it('破線と輪郭は、既定値なら書き出しで省き、使っていれば書く', () => {
    expect(fileNode(insertNode(createPage('p'), createRect({ x: 0, y: 0, width: 10, height: 10 })))).not.toHaveProperty('strokeDashes')
    const node = createPath(pathFromPoints([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }], true), true)
    const written = fileNode(insertNode(createPage('p'), node))
    expect(written).not.toHaveProperty('contours')
    expect(written).not.toHaveProperty('fillRule')
    const contours = [{ points: [{ x: 0.5, y: 0.5 }, { x: 0.6, y: 0.6 }], closed: true }]
    const holed = { ...node, strokeDashes: [3, 1], fillRule: 'evenodd' as const, contours }
    expect(fileNode(insertNode(createPage('p'), holed))).toMatchObject({ strokeDashes: [3, 1], fillRule: 'evenodd', contours })
  })

  it('マスクの指定（isMask）を検証し、既定値なら書かない。テキスト・画像・フレームは持たない', () => {
    expect(parseOne(rawNode({ isMask: true }))).toMatchObject({ isMask: true })
    expect(parseOne(rawNode({ type: 'ellipse', isMask: true }))).toMatchObject({ isMask: true })
    expect(() => parseOne(rawNode({ isMask: 'yes' }))).toThrow('isMask')
    expect('isMask' in parseOne(rawNode({ type: 'frame', isMask: true }))).toBe(false)
    expect(roundTrip(rawNode({ isMask: true })).isMask).toBe(true)
    expect('isMask' in roundTrip(rawNode({ isMask: false }))).toBe(false)
  })

  it('マスクの種類（maskType）を検証し、形（vector）なら書かない', () => {
    expect(parseOne(rawNode({ isMask: true, maskType: 'luminance' }))).toMatchObject({ maskType: 'luminance' })
    expect(parseOne(rawNode({ type: 'path', points: [{ x: 0, y: 0 }, { x: 1, y: 1 }], maskType: 'alpha' }))).toMatchObject({ maskType: 'alpha' })
    expect(() => parseOne(rawNode({ maskType: 'shape' }))).toThrow('maskType')
    expect('maskType' in parseOne(rawNode({ type: 'frame', maskType: 'alpha' }))).toBe(false)
    expect(roundTrip(rawNode({ maskType: 'luminance' })).maskType).toBe('luminance')
    expect('maskType' in roundTrip(rawNode({ maskType: 'vector' }))).toBe(false)
  })

  it('ブーリアン演算（booleanOperation）を検証し、null なら書かない。フレームだけが持ち、自動で並べるフレームには持てない', () => {
    expect(parseOne(rawNode({ type: 'frame', booleanOperation: 'subtract' }))).toMatchObject({ booleanOperation: 'subtract' })
    expect(() => parseOne(rawNode({ type: 'frame', booleanOperation: 'xor' }))).toThrow('booleanOperation')
    expect(() => parseOne(rawNode({ type: 'frame', booleanOperation: 'union', layout: {} }))).toThrow('booleanOperation')
    expect('booleanOperation' in parseOne(rawNode({ booleanOperation: 'union' }))).toBe(false)
    expect(roundTrip(rawNode({ type: 'frame', booleanOperation: 'exclude' })).booleanOperation).toBe('exclude')
    expect('booleanOperation' in roundTrip(rawNode({ type: 'frame', booleanOperation: null }))).toBe(false)
  })

  it('通過（passThrough）を検証し、false なら書かない。フレームだけが持つ', () => {
    expect(parseOne(rawNode({ type: 'frame', passThrough: true }))).toMatchObject({ passThrough: true })
    expect(() => parseOne(rawNode({ type: 'frame', passThrough: 'yes' }))).toThrow('passThrough')
    expect('passThrough' in parseOne(rawNode({ passThrough: true }))).toBe(false)
    expect(roundTrip(rawNode({ type: 'frame', passThrough: true })).passThrough).toBe(true)
    expect('passThrough' in roundTrip(rawNode({ type: 'frame', passThrough: false }))).toBe(false)
  })

  it('まとまりの説明文（setDescription）を検証し、空なら書かない。フレームだけが持つ', () => {
    expect(parseOne(rawNode({ type: 'frame', setDescription: '大きさ' }))).toMatchObject({ setDescription: '大きさ' })
    expect(() => parseOne(rawNode({ type: 'frame', setDescription: 1 }))).toThrow('setDescription')
    expect('setDescription' in parseOne(rawNode({ setDescription: 'x' }))).toBe(false)
    expect(roundTrip(rawNode({ type: 'frame', setDescription: '大きさ' })).setDescription).toBe('大きさ')
    expect('setDescription' in roundTrip(rawNode({ type: 'frame', setDescription: '' }))).toBe(false)
  })

  it('テキスト・画像の裏返し（flipX / flipY）を検証し、false なら書かない。ほかのノードは持たない', () => {
    const text = (patch: RawNode) => rawNode({ type: 'text', text: 'a', fontSize: 16, fontFamily: 'serif', ...patch })
    expect(parseOne(text({ flipX: true }))).toMatchObject({ flipX: true, flipY: false })
    expect(parseOne(rawNode({ type: 'image', assetId: 'a1', flipY: true }), { a1: PNG })).toMatchObject({ flipX: false, flipY: true })
    expect(() => parseOne(text({ flipX: 'yes' }))).toThrow('flipX')
    expect(() => parseOne(rawNode({ type: 'image', assetId: 'a1', flipY: 1 }), { a1: PNG })).toThrow('flipY')
    expect('flipX' in parseOne(rawNode({ flipX: true }))).toBe(false)
    expect(roundTrip(text({ flipX: true, flipY: true }))).toMatchObject({ flipX: true, flipY: true })
    const plain = roundTrip(text({ flipX: false }))
    expect('flipX' in plain || 'flipY' in plain).toBe(false)
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
    expect(() => parseOne(raw({ endCap: 'dot' }))).toThrow('endCap')
  })

  it('端の形（丸・四角・印）と端の大きさ capSize を検証する。capSize 0 は書き出しで省く', () => {
    const raw = (patch: RawNode) => rawNode({ type: 'path', points: [{ x: 0, y: 0 }, { x: 1, y: 1 }], ...patch })
    for (const cap of ['round', 'square', 'arrow', 'circle', 'diamond']) {
      expect(parseOne(raw({ startCap: cap, endCap: cap }))).toMatchObject({ startCap: cap, endCap: cap })
    }
    expect(parseOne(raw({}))).toMatchObject({ capSize: 0 })
    expect(parseOne(raw({ capSize: 24 }))).toMatchObject({ capSize: 24 })
    expect(() => parseOne(raw({ capSize: -1 }))).toThrow('capSize')
    expect(() => parseOne(raw({ capSize: '8' }))).toThrow('capSize')
    const path = createPath(pathFromPoints([{ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 20, y: 0 }]), false)
    expect(fileNode(insertNode(createPage(), path))).not.toHaveProperty('capSize')
    const sized = { ...path, endCap: 'circle' as const, capSize: 12 }
    expect(fileNode(insertNode(createPage(), sized))).toMatchObject({ endCap: 'circle', capSize: 12 })
    expect(parseOne(fileNode(insertNode(createPage(), sized)))).toEqual(sized)
  })

  it('頂点の角の丸め radius を検証する。0 や省略は丸めない頂点で、書き出しでも書かない', () => {
    const raw = (points: unknown) => rawNode({ type: 'path', points, closed: true })
    const square = [{ x: 0, y: 0, radius: 8 }, { x: 1, y: 0 }, { x: 1, y: 1, radius: 0 }]
    expect(parseOne(raw(square))).toMatchObject({ points: [{ x: 0, y: 0, radius: 8 }, { x: 1, y: 0 }, { x: 1, y: 1 }] })
    expect(parseOne(raw(square))).not.toHaveProperty('points.2.radius')
    expect(() => parseOne(raw([{ x: 0, y: 0, radius: -2 }, { x: 1, y: 1 }]))).toThrow('points[0].radius')
    expect(() => parseOne(raw([{ x: 0, y: 0 }, { x: 1, y: 1, radius: 'a' }]))).toThrow('points[1].radius')
    const path = createPath(pathFromPoints([{ x: 0, y: 0, radius: 6 }, { x: 40, y: 0 }, { x: 40, y: 40 }], true), true)
    const file = fileNode(insertNode(createPage(), path))
    // 枠は丸めた形を囲むので、丸めた頂点は枠の外（割合が 0 未満）に出る
    expect((file.points as RawNode[])[0]).toMatchObject({ radius: 6 })
    expect((file.points as RawNode[])[0].x).toBeLessThan(0)
    expect(Object.keys((file.points as RawNode[])[1])).toEqual(['x', 'y'])
    expect(parseOne(file)).toEqual(path)
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
    // 説明文とプロパティは省けば空
    expect(parseOne(main)).toEqual(expect.objectContaining({ component: { id: 'c1', role: 'main', description: '', properties: [] } }))
    expect(parseOne(main)).not.toHaveProperty('component.overrides')
    expect(() => parseOne(rawNode({ type: 'frame', component: { id: 'c1', role: 'copy' } }))).toThrow('component.role')
    expect(() => parseOne(rawNode({ type: 'frame', component: { id: '../x', role: 'main', description: '', properties: [] } }))).toThrow('component.id')
  })

  it('コンポーネントの説明文とプロパティを検証し、空なら書き出さない', () => {
    const withMain = (link: Record<string, unknown>) => rawNode({ type: 'frame', component: { id: 'c1', role: 'main', ...link } })
    const properties = [
      { name: '文言', type: 'text', targets: ['n1'] },
      { name: '印', type: 'boolean', targets: ['n2', 'n3'] },
      { name: 'アイコン', type: 'instance', targets: [] },
    ]
    expect(parseOne(withMain({ description: '主な操作', properties }))).toMatchObject({
      component: { description: '主な操作', properties },
    })
    // targets は省けば空
    expect(parseOne(withMain({ properties: [{ name: 'a', type: 'text' }] }))).toMatchObject({
      component: { properties: [{ name: 'a', type: 'text', targets: [], preferred: [] }] },
    })
    expect(() => parseOne(withMain({ description: 1 }))).toThrow('component.description')
    expect(() => parseOne(withMain({ properties: {} }))).toThrow('component.properties')
    expect(() => parseOne(withMain({ properties: [{ name: 'a', type: 'color' }] }))).toThrow('component.properties[0].type')
    expect(() => parseOne(withMain({ properties: [{ name: ' ', type: 'text' }] }))).toThrow('component.properties[0].name')
    expect(() => parseOne(withMain({ properties: [{ name: 'a', type: 'text', targets: ['../x'] }] }))).toThrow('properties[0].targets[0]')
    expect(() => parseOne(withMain({ properties: [{ name: 'a', type: 'text' }, { name: 'a', type: 'boolean' }] }))).toThrow('重複')

    const frame = { ...createFrame({ x: 0, y: 0, width: 10, height: 10 }), component: { id: 'c1', role: 'main' as const, description: '', properties: [] } }
    const page = insertNode(createPage(), frame)
    expect(fileNode(page).component).toEqual({ id: 'c1', role: 'main' })
    const described = insertNode(createPage(), { ...frame, component: { ...frame.component, description: 'x', properties: [{ name: 'a', type: 'text' as const, targets: [], preferred: [] }] } })
    expect(fileNode(described).component).toEqual({ id: 'c1', role: 'main', description: 'x', properties: [{ name: 'a', type: 'text', targets: [] }] })

    // 差し替えの候補（preferred）: 省けば空、重なりはまとめる、空でなければ書き出す
    expect(parseOne(withMain({ properties: [{ name: 'a', type: 'instance', preferred: ['c2', 'c3', 'c2'] }] }))).toMatchObject({
      component: { properties: [{ name: 'a', type: 'instance', targets: [], preferred: ['c2', 'c3'] }] },
    })
    expect(parseOne(withMain({ properties: [{ name: 'a', type: 'instance' }] }))).toMatchObject({
      component: { properties: [{ preferred: [] }] },
    })
    expect(() => parseOne(withMain({ properties: [{ name: 'a', type: 'instance', preferred: 'c2' }] }))).toThrow('properties[0].preferred')
    expect(() => parseOne(withMain({ properties: [{ name: 'a', type: 'instance', preferred: ['../x'] }] }))).toThrow('properties[0].preferred[0]')
    const preferred = insertNode(createPage(), { ...frame, component: { ...frame.component, properties: [{ name: 'a', type: 'instance' as const, targets: [], preferred: ['c2'] }] } })
    expect(fileNode(preferred).component).toEqual({ id: 'c1', role: 'main', properties: [{ name: 'a', type: 'instance', targets: [], preferred: ['c2'] }] })
  })

  it('インスタンスごとの上書きを検証する', () => {
    const withOverrides = (overrides: unknown) => rawNode({ type: 'frame', component: { id: 'c1', role: 'instance', overrides } })
    const overrides = {
      n1: { text: '送信', fills: solid('#ff0000'), visible: false },
      n2: { fills: [], strokes: [] },
      n3: { fills: [{ type: 'linear', x1: 0.5, y1: 0, x2: 0.5, y2: 1, stops: [{ offset: 0, color: '#000000' }, { offset: 1, color: '#ffffff' }], opacity: 1 }] },
      n4: { fontSize: 24, fontFamily: 'serif', fontWeight: 700 },
      n5: { strokeDashes: [4, 2], strokeDashOffset: 1.5 },
      n6: { strokeDashes: [] },
      n7: { flipX: true, flipY: false },
    }
    expect(parseOne(withOverrides(overrides))).toMatchObject({ component: { id: 'c1', role: 'instance', overrides } })
    // 知らない項目は捨てる。省けば上書きなし
    const loaded = parseOne(withOverrides({ n1: { text: 'a', width: 999 } }))
    expect(loaded).toMatchObject({ component: { overrides: { n1: { text: 'a' } } } })
    expect(loaded).not.toHaveProperty('component.overrides.n1.width')
    expect(parseOne(withOverrides(undefined))).toMatchObject({ component: { overrides: {} } })

    expect(() => parseOne(withOverrides({ n1: { fills: '#ff0000' } }))).toThrow('overrides.n1.fills')
    expect(() => parseOne(withOverrides({ n1: { strokes: [{ type: 'solid', color: 'red', opacity: 1 }] } }))).toThrow('overrides.n1.strokes')
    expect(() => parseOne(withOverrides({ n1: { text: 1 } }))).toThrow('overrides.n1.text')
    expect(() => parseOne(withOverrides({ n1: { fontWeight: 450 } }))).toThrow('overrides.n1.fontWeight')
    expect(() => parseOne(withOverrides({ n1: { assetId: 'nothing' } }))).toThrow('上書きの画像データがありません')
    expect(() => parseOne(withOverrides({ n1: { visible: 'no' } }))).toThrow('overrides.n1.visible')
    expect(() => parseOne(withOverrides({ n1: { flipX: 'yes' } }))).toThrow('overrides.n1.flipX')
    expect(() => parseOne(withOverrides({ n1: { flipY: 0 } }))).toThrow('overrides.n1.flipY')
    expect(() => parseOne(withOverrides({ n1: { strokeDashes: [-1] } }))).toThrow('overrides.n1.strokeDashes')
    expect(() => parseOne(withOverrides({ n1: { strokeDashOffset: null } }))).toThrow('overrides.n1.strokeDashOffset')
    // 入れ子のインスタンスの差し替え。差し替え先のコンポーネントは、ファイルになくても読める（同期で無視される）
    expect(parseOne(withOverrides({ n1: { componentId: 'c9' } }))).toMatchObject({ component: { overrides: { n1: { componentId: 'c9' } } } })
    expect(() => parseOne(withOverrides({ n1: { componentId: 3 } }))).toThrow('overrides.n1.componentId')
    expect(() => parseOne(withOverrides({ n1: { componentId: '__proto__' } }))).toThrow('overrides.n1.componentId')
    expect(() => parseOne(withOverrides({ '../x': {} }))).toThrow('不正な id')
    expect(() => parseOne(withOverrides([]))).toThrow('component.overrides')
    // 画像の差し替えは、ファイルの中の画像を指していればよい
    expect(parseOne(withOverrides({ n1: { assetId: 'a1' } }), { a1: PNG })).toMatchObject({ component: { overrides: { n1: { assetId: 'a1' } } } })
  })

  it('画像は対応形式のバイト列で、データが揃っているものだけ受け付ける', () => {
    const image = rawNode({ type: 'image', assetId: 'a1' })
    expect(parseKdr(kdrOf([image]), { a1: PNG }).assets).toEqual({ a1: PNG })
    expect(parseOne(image, { a1: PNG })).toMatchObject({ fit: 'cover', cornerRadius: 0, positionX: 0.5, positionY: 0.5, scale: 1 })
    expect(parseOne({ ...image, positionX: 0, positionY: 1 }, { a1: PNG })).toMatchObject({ positionX: 0, positionY: 1 })
    // 切り抜きの拡大は 1〜100。1 なら書き出しで省く
    expect(parseOne({ ...image, scale: 2.5 }, { a1: PNG })).toMatchObject({ scale: 2.5 })
    expect(() => parseOne({ ...image, scale: 0.5 }, { a1: PNG })).toThrow('scale')
    expect(() => parseOne({ ...image, scale: 101 }, { a1: PNG })).toThrow('scale')
    expect(roundTrip({ ...image, scale: 1 }, { a1: PNG })).not.toHaveProperty('scale')
    expect(roundTrip({ ...image, scale: 3 }, { a1: PNG })).toMatchObject({ scale: 3 })
    expect(() => parseOne({ ...image, positionX: 1.5 }, { a1: PNG })).toThrow('positionX')
    expect(() => parseOne(image, {})).toThrow('画像データ')
    expect(() => parseOne(image, { a1: { ...PNG, mime: 'image/svg+xml' } })).toThrow('画像形式')
    expect(() => parseOne(image, { a1: { mime: 'image/png', data: 'iVBORw0K' } })).toThrow('バイト列')
    expect(() => parseOne(image, { a1: { mime: 'image/png', bytes: [1, 2, 3] } })).toThrow('バイト列')
    expect(() => parseOne(image, { a1: null })).toThrow('assets.a1')
  })

  it('画像の画素数に上限を設ける（見出しの大きさで確かめる）', () => {
    const image = rawNode({ type: 'image', assetId: 'a1' })
    expect(parseOne(image, { a1: { mime: 'image/png', bytes: pngHeader(8000, 8000) } })).toMatchObject({ assetId: 'a1' })
    expect(() => parseOne(image, { a1: { mime: 'image/png', bytes: pngHeader(8001, 8000) } })).toThrow('assets.a1: 画像の画素数が多すぎます')
    // 使っていない画像も確かめる
    expect(() => parseKdr(kdrOf([]), { a1: { mime: 'image/png', bytes: pngHeader(100_000, 1_000) } })).toThrow('画素数')
  })

  it('書体名の長さと文字を検証する', () => {
    const text = (fontFamily: unknown) => rawNode({ type: 'text', text: 'a', fontSize: 16, fontFamily })
    expect(parseOne(text('"Noto Sans JP", sans-serif'))).toMatchObject({ fontFamily: '"Noto Sans JP", sans-serif' })
    expect(parseOne(text('ヒラギノ角ゴ ProN'))).toMatchObject({ fontFamily: 'ヒラギノ角ゴ ProN' })
    expect(parseOne(text('a'.repeat(MAX_FONT_FAMILY_LENGTH)))).toMatchObject({ fontFamily: 'a'.repeat(MAX_FONT_FAMILY_LENGTH) })
    expect(() => parseOne(text('a'.repeat(MAX_FONT_FAMILY_LENGTH + 1)))).toThrow('fontFamily: 書体名が長すぎます')
    for (const bad of ['a;b', 'a{b', 'a}b', 'a<b', 'a>b', 'a\\b', 'a\nb', 'a\u0000b']) {
      expect(() => parseOne(text(bad))).toThrow('fontFamily: 書体名に使えない文字があります')
    }
    // インスタンスの上書きも同じ
    const withOverride = (fontFamily: string) => rawNode({ type: 'frame', component: { id: 'c1', role: 'instance', overrides: { n1: { fontFamily } } } })
    expect(parseOne(withOverride('serif'))).toMatchObject({ component: { overrides: { n1: { fontFamily: 'serif' } } } })
    expect(() => parseOne(withOverride('a}b'))).toThrow('overrides.n1.fontFamily')
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
