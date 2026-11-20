import { describe, expect, it } from 'vitest'
import { KdrError, decodeKdr, parseKdr } from '../document/kdr.ts'
import type { DesignDocument, Page, Scene, TextNode } from '../document/types.ts'
import { encodeKdr } from './exportKdr.ts'
import { createEllipse, createFrame, createImage, createLine, createRect, createText } from './nodes.ts'
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

function kdrJson(document: unknown, version = 5) {
  return { format: 'kadrokreo', version, document }
}

/** 1 ページだけの最新 version のファイル */
function kdrOf(scene: unknown, assets: unknown = {}) {
  return kdrJson({ name: 'x', pages: [{ id: 'p1', name: 'Page 1', ...(scene as object) }], assets })
}

/** version 3 までの形。document が直接ノードを持つ */
function legacyJson(scene: Scene, version: number, assets?: unknown) {
  return kdrJson({ name: 'x', nodes: scene.nodes, rootIds: scene.rootIds, assets }, version)
}

function sceneOf(...nodes: ({ id: string } & Record<string, unknown>)[]) {
  return {
    nodes: Object.fromEntries(nodes.map((node) => [node.id, node])),
    rootIds: nodes.map((node) => node.id),
  }
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

describe('parseKdr', () => {
  const valid = () => structuredClone(samplePage())

  it('別形式や未対応バージョンを拒否する', () => {
    const doc = documentOf(valid())
    expect(() => parseKdr({ format: 'other', version: 1, document: doc })).toThrow(KdrError)
    expect(() => parseKdr(kdrJson(doc, 6))).toThrow('新しいバージョン')
    expect(() => parseKdr(kdrJson(doc, 1.5))).toThrow('未対応')
    expect(() => parseKdr(kdrJson(doc, 0))).toThrow('未対応')
    expect(() => parseKdr(null)).toThrow(KdrError)
  })

  it('ページは 1 つ以上あり、id が重複していないこと', () => {
    const page = valid()
    expect(parseKdr(kdrJson(documentOf(page, createPage('B')))).pages.map((p) => p.name)).toEqual(['ホーム', 'B'])
    expect(() => parseKdr(kdrJson(documentOf()))).toThrow('ページがありません')
    expect(() => parseKdr(kdrJson(documentOf(page, { ...createPage('B'), id: page.id })))).toThrow('重複')
    // version 4 では、document が直接ノードを持つ古い形は受け付けない
    expect(() => parseKdr(legacyJson(page, 4, {}))).toThrow(KdrError)
  })

  it('ノードの id はページごとに独立している', () => {
    const page = valid()
    const doc = documentOf(page, { ...structuredClone(page), id: 'other', name: 'コピー' })
    expect(parseKdr(kdrJson(doc)).pages).toHaveLength(2)
  })

  it('version 1 のファイルも読める（画像なし、テキストは折り返さない、1 ページ）', () => {
    const page = valid()
    const textId = Object.keys(page.nodes).find((id) => page.nodes[id].type === 'text')!
    const { autoWidth: _autoWidth, ...text } = page.nodes[textId] as TextNode
    const v1 = { ...page, nodes: { ...page.nodes, [textId]: text } } as Scene

    const loaded = parseKdr(legacyJson(v1, 1))
    expect(loaded.assets).toEqual({})
    expect(loaded.pages).toHaveLength(1)
    expect(loaded.pages[0].nodes[textId]).toMatchObject({ autoWidth: true })
    // version 2 では省略できない
    expect(() => parseKdr(legacyJson(v1, 2, {}))).toThrow(KdrError)
  })

  it('version 2 のファイルも読める（影・角丸・文字スタイルは当時の見た目になる値で補う）', () => {
    const page = valid()
    const v2Nodes = Object.fromEntries(
      Object.entries(page.nodes).map(([id, node]) => {
        const { shadow: _s, fontWeight: _w, textAlign: _a, lineHeight: _l, ...rest } = node as Record<string, unknown>
        if (node.type === 'frame') delete rest.cornerRadius
        return [id, rest]
      }),
    )
    const v2 = { nodes: v2Nodes, rootIds: page.rootIds } as unknown as Scene

    const loaded = parseKdr(legacyJson(v2, 2, {}))
    expect(loaded.pages).toEqual([{ id: 'page-1', name: 'Page 1', nodes: page.nodes, rootIds: page.rootIds }])
    // version 3 では省略できない
    expect(() => parseKdr(legacyJson(v2, 3, {}))).toThrow(KdrError)
  })

  it('version 3 のファイルは 1 ページのドキュメントとして読める', () => {
    const page = valid()
    const loaded = parseKdr(legacyJson(page, 3, {}))
    expect(loaded).toEqual({
      name: 'x',
      pages: [{ id: 'page-1', name: 'Page 1', nodes: page.nodes, rootIds: page.rootIds }],
      assets: {},
    })
  })

  it('version 4 のファイルも読める（回転なし）', () => {
    const page = valid()
    const v4Nodes = Object.fromEntries(
      Object.entries(page.nodes).map(([id, { rotation: _rotation, ...rest }]) => [id, rest]),
    )
    const v4 = { name: 'x', pages: [{ ...page, nodes: v4Nodes }], assets: {} }

    expect(parseKdr(kdrJson(v4, 4)).pages[0]).toEqual(page)
    // version 5 では省略できない
    expect(() => parseKdr(kdrJson(v4, 5))).toThrow('rotation')
  })

  it('直線と影を検証する', () => {
    const line = createLine({ x: 0, y: 0, width: 10, height: 0 }, 'up')
    const rect = {
      ...createRect({ x: 0, y: 0, width: 10, height: 10 }),
      shadow: { x: 0, y: 4, blur: 12, color: '#000000', opacity: 0.25 },
    }
    expect(parseKdr(kdrOf(sceneOf(line, rect))).pages[0].nodes).toEqual({ [line.id]: line, [rect.id]: rect })

    expect(() => parseKdr(kdrOf(sceneOf({ ...line, direction: 'sideways' })))).toThrow('direction')
    expect(() => parseKdr(kdrOf(sceneOf({ ...rect, shadow: { ...rect.shadow, opacity: 2 } })))).toThrow('shadow.opacity')
    expect(() => parseKdr(kdrOf(sceneOf({ ...rect, shadow: { ...rect.shadow, color: 'red' } })))).toThrow('shadow.color')
    const text = createText({ x: 0, y: 0, width: 1, height: 1 }, 'a')
    expect(() => parseKdr(kdrOf(sceneOf({ ...text, fontWeight: 900 })))).toThrow('fontWeight')
  })

  it('画像は対応形式の base64 で、データが揃っているものだけ受け付ける', () => {
    const scene = sceneOf(createImage({ x: 0, y: 0, width: 10, height: 10 }, 'a1'))
    expect(parseKdr(kdrOf(scene, { a1: PNG })).assets).toEqual({ a1: PNG })
    expect(() => parseKdr(kdrOf(scene, {}))).toThrow('画像データ')
    expect(() => parseKdr(kdrOf(scene, { a1: { ...PNG, mime: 'image/svg+xml' } }))).toThrow('画像形式')
    expect(() => parseKdr(kdrOf(scene, { a1: { ...PNG, data: '<svg onload=alert(1)>' } }))).toThrow('base64')
  })

  it('知らないフィールドは捨てる', () => {
    const page = valid()
    const id = page.rootIds[0]
    Object.assign(page.nodes[id], { onclick: 'alert(1)' })
    expect(parseKdr(kdrOf(page)).pages[0].nodes[id]).not.toHaveProperty('onclick')
  })

  it('型の合わないフィールドを拒否する', () => {
    const page = valid()
    Object.assign(page.nodes[page.rootIds[0]], { width: '400' })
    expect(() => parseKdr(kdrOf(page))).toThrow(KdrError)
  })

  it('#rrggbb 以外の色を拒否する', () => {
    const page = valid()
    Object.assign(page.nodes[page.rootIds[0]], { fill: 'url(https://example.com/x.png)' })
    expect(() => parseKdr(kdrOf(page))).toThrow('色')
  })

  it('深すぎる入れ子を拒否する', () => {
    const nodes: Record<string, unknown> = {}
    for (let i = 0; i <= 100; i++) {
      nodes[`n${i}`] = {
        ...createFrame({ x: 0, y: 0, width: 1, height: 1 }),
        id: `n${i}`,
        parentId: i === 0 ? null : `n${i - 1}`,
        children: i === 100 ? [] : [`n${i + 1}`],
      }
    }
    expect(() => parseKdr(kdrOf({ nodes, rootIds: ['n0'] }))).toThrow('深すぎ')
  })

  it('存在しないノードへの参照を拒否する', () => {
    const page = valid()
    page.rootIds.push('missing')
    expect(() => parseKdr(kdrOf(page))).toThrow('存在しない')
  })

  it('Object.prototype のプロパティ名を id として通さない', () => {
    const page = valid()
    page.rootIds.push('constructor')
    expect(() => parseKdr(kdrOf(page))).toThrow(KdrError)
    expect(() => parseKdr(kdrOf({ ...valid(), rootIds: ['__proto__'] }))).toThrow(KdrError)
  })

  it('同じノードが二重に参照されていたら拒否する', () => {
    const page = valid()
    page.rootIds.push(page.rootIds[0])
    expect(() => parseKdr(kdrOf(page))).toThrow('複数の場所')
  })

  it('parentId が実際の親と食い違っていたら拒否する', () => {
    const page = valid()
    page.nodes[page.rootIds[1]].parentId = page.rootIds[0]
    expect(() => parseKdr(kdrOf(page))).toThrow('parentId')
  })

  it('どこからも辿れないノード（循環を含む）を拒否する', () => {
    const a = { ...createFrame({ x: 0, y: 0, width: 1, height: 1 }), id: 'a', parentId: 'b', children: ['b'] }
    const b = { ...a, id: 'b', parentId: 'a', children: ['a'] }
    expect(() => parseKdr(kdrOf({ nodes: { a, b }, rootIds: [] }))).toThrow('参照されていない')
  })
})
