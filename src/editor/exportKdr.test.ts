import { describe, expect, it } from 'vitest'
import { KdrError, decodeKdr, parseKdr } from '../document/kdr.ts'
import type { DesignDocument } from '../document/types.ts'
import { encodeKdr } from './exportKdr.ts'
import { createEllipse, createFrame, createRect, createText } from './nodes.ts'
import { createDocument, insertNode } from './operations.ts'

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

function kdrJson(document: unknown, version = 1) {
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
    expect(() => parseKdr(kdrJson(valid(), 2))).toThrow('新しいバージョン')
    expect(() => parseKdr(kdrJson(valid(), 0))).toThrow('未対応')
    expect(() => parseKdr(null)).toThrow(KdrError)
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
    expect(() => parseKdr(kdrJson({ name: 'deep', nodes, rootIds: ['n0'] }))).toThrow('深すぎ')
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
    const doc = { name: 'loop', nodes: { a, b }, rootIds: [] }
    expect(() => parseKdr(kdrJson(doc))).toThrow('参照されていない')
  })
})
