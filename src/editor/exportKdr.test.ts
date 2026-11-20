import { describe, expect, it } from 'vitest'
import { KdrError, decodeKdr, parseKdr } from '../document/kdr.ts'
import type { DesignDocument, TextNode } from '../document/types.ts'
import { encodeKdr } from './exportKdr.ts'
import { createEllipse, createFrame, createImage, createLine, createRect, createText } from './nodes.ts'
import { addAsset, createDocument, insertNode, removeNodes } from './operations.ts'

function sampleDocument(): DesignDocument {
  const frame = createFrame({ x: 0, y: 0, width: 400, height: 300 })
  let doc = createDocument('サンプル')
  doc = insertNode(doc, frame)
  doc = insertNode(doc, createRect({ x: 10, y: 10, width: 50, height: 50 }), frame.id)
  doc = insertNode(doc, createText({ x: 10, y: 80, width: 200, height: 20 }, 'こんにちは'), frame.id)
  doc = insertNode(doc, createEllipse({ x: 500, y: 0, width: 80, height: 80 }))
  return doc
}

async function gzip(text: string): Promise<Blob> {
  return new Response(new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))).blob()
}

// 1x1 の透明な PNG
const PNG = {
  mime: 'image/png',
  data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
}

function kdrJson(document: unknown, version = 3) {
  return { format: 'kadrokreo', version, document }
}

describe('kdr', () => {
  it('書き出したファイルを読み込むと同じドキュメントに戻る', async () => {
    const doc = sampleDocument()
    expect(await decodeKdr(await encodeKdr(doc))).toEqual(doc)
  })

  it('実体は gzip 圧縮された 1 つの JSON', async () => {
    const bytes = new Uint8Array(await (await encodeKdr(sampleDocument())).arrayBuffer())
    expect([...bytes.slice(0, 2)]).toEqual([0x1f, 0x8b])
  })

  it('画像を埋め込んだまま往復し、使われていない画像は書き出さない', async () => {
    const used = createImage({ x: 0, y: 0, width: 1, height: 1 }, 'used')
    const unused = createImage({ x: 0, y: 0, width: 1, height: 1 }, 'unused')
    let doc = addAsset(addAsset(createDocument(), 'used', PNG), 'unused', PNG)
    doc = insertNode(insertNode(doc, used), unused)
    doc = removeNodes(doc, [unused.id])

    const loaded = await decodeKdr(await encodeKdr(doc))
    expect(loaded.assets).toEqual({ used: PNG })
    expect(loaded.nodes[used.id]).toEqual(used)
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
  const valid = () => structuredClone(sampleDocument())

  it('別形式や未対応バージョンを拒否する', () => {
    expect(() => parseKdr({ format: 'other', version: 1, document: valid() })).toThrow(KdrError)
    expect(() => parseKdr(kdrJson(valid(), 4))).toThrow('新しいバージョン')
    expect(() => parseKdr(kdrJson(valid(), 0))).toThrow('未対応')
    expect(() => parseKdr(null)).toThrow(KdrError)
  })

  it('version 1 のファイルも読める（画像なし、テキストは折り返さない）', () => {
    const { assets: _assets, ...doc } = valid()
    const textId = Object.keys(doc.nodes).find((id) => doc.nodes[id].type === 'text')!
    const { autoWidth: _autoWidth, ...text } = doc.nodes[textId] as TextNode
    const v1 = { ...doc, nodes: { ...doc.nodes, [textId]: text } }

    const loaded = parseKdr(kdrJson(v1, 1))
    expect(loaded.assets).toEqual({})
    expect(loaded.nodes[textId]).toMatchObject({ autoWidth: true })
    // version 2 では省略できない
    expect(() => parseKdr(kdrJson(v1, 2))).toThrow(KdrError)
  })

  it('version 2 のファイルも読める（影・角丸・文字スタイルは当時の見た目になる値で補う）', () => {
    const doc = valid()
    const v2Nodes = Object.fromEntries(
      Object.entries(doc.nodes).map(([id, node]) => {
        const { shadow: _s, fontWeight: _w, textAlign: _a, lineHeight: _l, ...rest } = node as Record<string, unknown>
        if (node.type === 'frame') delete rest.cornerRadius
        return [id, rest]
      }),
    )
    const v2 = { ...doc, nodes: v2Nodes }

    const loaded = parseKdr(kdrJson(v2, 2))
    expect(loaded).toEqual(doc)
    // version 3 では省略できない
    expect(() => parseKdr(kdrJson(v2, 3))).toThrow(KdrError)
  })

  it('直線と影を検証する', () => {
    const line = createLine({ x: 0, y: 0, width: 10, height: 0 }, 'up')
    const rect = {
      ...createRect({ x: 0, y: 0, width: 10, height: 10 }),
      shadow: { x: 0, y: 4, blur: 12, color: '#000000', opacity: 0.25 },
    }
    const withNodes = (...nodes: ({ id: string } & Record<string, unknown>)[]) => ({
      name: 'x',
      nodes: Object.fromEntries(nodes.map((node) => [node.id, node])),
      rootIds: nodes.map((node) => node.id),
      assets: {},
    })
    expect(parseKdr(kdrJson(withNodes(line, rect))).nodes).toEqual({ [line.id]: line, [rect.id]: rect })

    expect(() => parseKdr(kdrJson(withNodes({ ...line, direction: 'sideways' })))).toThrow('direction')
    expect(() => parseKdr(kdrJson(withNodes({ ...rect, shadow: { ...rect.shadow, opacity: 2 } })))).toThrow('shadow.opacity')
    expect(() => parseKdr(kdrJson(withNodes({ ...rect, shadow: { ...rect.shadow, color: 'red' } })))).toThrow('shadow.color')
    const text = createText({ x: 0, y: 0, width: 1, height: 1 }, 'a')
    expect(() => parseKdr(kdrJson(withNodes({ ...text, fontWeight: 900 })))).toThrow('fontWeight')
  })

  it('画像は対応形式の base64 で、データが揃っているものだけ受け付ける', () => {
    const image = createImage({ x: 0, y: 0, width: 10, height: 10 }, 'a1')
    const withImage = (assets: unknown) => ({
      ...valid(),
      nodes: { [image.id]: image },
      rootIds: [image.id],
      assets,
    })
    expect(parseKdr(kdrJson(withImage({ a1: PNG }))).assets).toEqual({ a1: PNG })
    expect(() => parseKdr(kdrJson(withImage({})))).toThrow('画像データ')
    expect(() => parseKdr(kdrJson(withImage({ a1: { ...PNG, mime: 'image/svg+xml' } })))).toThrow('画像形式')
    expect(() => parseKdr(kdrJson(withImage({ a1: { ...PNG, data: '<svg onload=alert(1)>' } })))).toThrow('base64')
  })

  it('知らないフィールドは捨てる', () => {
    const doc = valid()
    const id = doc.rootIds[0]
    Object.assign(doc.nodes[id], { onclick: 'alert(1)' })
    expect(parseKdr(kdrJson(doc)).nodes[id]).not.toHaveProperty('onclick')
  })

  it('型の合わないフィールドを拒否する', () => {
    const doc = valid()
    Object.assign(doc.nodes[doc.rootIds[0]], { width: '400' })
    expect(() => parseKdr(kdrJson(doc))).toThrow(KdrError)
  })

  it('#rrggbb 以外の色を拒否する', () => {
    const doc = valid()
    Object.assign(doc.nodes[doc.rootIds[0]], { fill: 'url(https://example.com/x.png)' })
    expect(() => parseKdr(kdrJson(doc))).toThrow('色')
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
    expect(() => parseKdr(kdrJson({ name: 'deep', nodes, rootIds: ['n0'], assets: {} }))).toThrow('深すぎ')
  })

  it('存在しないノードへの参照を拒否する', () => {
    const doc = valid()
    doc.rootIds.push('missing')
    expect(() => parseKdr(kdrJson(doc))).toThrow('存在しない')
  })

  it('Object.prototype のプロパティ名を id として通さない', () => {
    const doc = valid()
    doc.rootIds.push('constructor')
    expect(() => parseKdr(kdrJson(doc))).toThrow(KdrError)
    expect(() => parseKdr(kdrJson({ ...valid(), rootIds: ['__proto__'] }))).toThrow(KdrError)
  })

  it('同じノードが二重に参照されていたら拒否する', () => {
    const doc = valid()
    doc.rootIds.push(doc.rootIds[0])
    expect(() => parseKdr(kdrJson(doc))).toThrow('複数の場所')
  })

  it('parentId が実際の親と食い違っていたら拒否する', () => {
    const doc = valid()
    doc.nodes[doc.rootIds[1]].parentId = doc.rootIds[0]
    expect(() => parseKdr(kdrJson(doc))).toThrow('parentId')
  })

  it('どこからも辿れないノード（循環を含む）を拒否する', () => {
    const a = { ...createFrame({ x: 0, y: 0, width: 1, height: 1 }), id: 'a', parentId: 'b', children: ['b'] }
    const b = { ...a, id: 'b', parentId: 'a', children: ['a'] }
    const doc = { name: 'loop', nodes: { a, b }, rootIds: [], assets: {} }
    expect(() => parseKdr(kdrJson(doc))).toThrow('参照されていない')
  })
})
