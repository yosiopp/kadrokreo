import { describe, expect, it } from 'vitest'
import { sha256Hex } from '../../document/sha256.ts'
import type { DesignDocument } from '../../document/types.ts'
import { createFrame, createImage, createRect } from '../nodes.ts'
import { copyFragment } from './clipboard.ts'
import {
  addAsset,
  addOrReuseAsset,
  addPage,
  createDocument,
  createPage,
  duplicatePage,
  moveNodesToPage,
  movePage,
  pasteIntoPage,
  pruneAssets,
  removePage,
  renamePage,
  updatePage,
} from './document.ts'
import { insertNode } from './tree.ts'

const bounds = { x: 0, y: 0, width: 100, height: 100 }

function fixture() {
  const frame = createFrame({ x: 100, y: 50, width: 400, height: 300 })
  const inner = createFrame({ x: 20, y: 10, width: 200, height: 100 })
  const rect = createRect({ x: 5, y: 5, width: 10, height: 10 })
  const loose = createRect({ ...bounds, x: 900 })
  let doc = createPage()
  doc = insertNode(doc, frame)
  doc = insertNode(doc, inner, frame.id)
  doc = insertNode(doc, rect, inner.id)
  doc = insertNode(doc, loose)
  return { doc, frame, inner, rect, loose }
}

describe('assets', () => {
  const asset = { mime: 'image/png', bytes: new Uint8Array([1, 2, 3]) }
  const image = createImage(bounds, 'a')
  const withImage = () => {
    const doc = createDocument()
    return addAsset(updatePage(doc, doc.pages[0].id, (page) => insertNode(page, image)), 'a', asset)
  }

  it('中身が同じ画像は、新しいアセットを作らずに既存のものを使う', () => {
    const doc = withImage()
    let made = 0
    const newId = () => `new${++made}`
    // 同じ中身（別のオブジェクト）なら、そのままのドキュメントと既存の id
    const same = addOrReuseAsset(doc, { mime: 'image/png', bytes: new Uint8Array([1, 2, 3]) }, newId)
    expect(same).toEqual({ document: doc, assetId: 'a' })
    expect(same.document).toBe(doc)
    // 中身か形式が違えば、中身の SHA-256 を id にして足す
    const bytes = new Uint8Array([1, 2, 4])
    const other = addOrReuseAsset(doc, { mime: 'image/png', bytes }, newId)
    expect(other.assetId).toBe(sha256Hex(bytes))
    expect(other.document.assets).toEqual({ a: asset, [sha256Hex(bytes)]: { mime: 'image/png', bytes } })
    expect(addOrReuseAsset(doc, { mime: 'image/jpeg', bytes: new Uint8Array([1, 2, 3]) }, newId).assetId).toBe(sha256Hex(new Uint8Array([1, 2, 3])))
    expect(made).toBe(0)
  })

  it('ハッシュの id がすでに別の中身で使われていれば（細工されたファイル）、別の id で足す', () => {
    const bytes = new Uint8Array([9, 9])
    const doc = addAsset(createDocument(), sha256Hex(bytes), { mime: 'image/png', bytes: new Uint8Array([7]) })
    expect(addOrReuseAsset(doc, { mime: 'image/png', bytes }, () => 'fallback').assetId).toBe('fallback')
  })

  it('どのページでも使われていないアセットを除く', () => {
    const doc = addAsset(withImage(), 'b', asset)
    expect(pruneAssets(doc).assets).toEqual({ a: asset })

    const clean = withImage()
    expect(pruneAssets(clean)).toBe(clean)

    // 別のページで使われていれば残す
    const other = insertNode(createPage('other'), createImage(bounds, 'b'))
    expect(pruneAssets(addPage(doc, other)).assets).toEqual({ a: asset, b: asset })
  })

  it('コピーしたノードは、アセットのない別のドキュメントへ貼っても画像が欠けない', () => {
    const source = withImage()
    const fragment = copyFragment(source.pages[0], source.assets, [image.id])
    expect(fragment.assets).toEqual({ a: asset })

    const empty = createDocument()
    const { document: pasted, ids } = pasteIntoPage(empty, empty.pages[0].id, fragment)
    expect(pasted.assets).toEqual({ a: asset })
    expect(pasted.pages[0].nodes[ids[0]]).toMatchObject({ type: 'image', assetId: 'a' })

    // 同じドキュメント内なら assets は作り直さない
    expect(pasteIntoPage(source, source.pages[0].id, fragment).document.assets).toBe(source.assets)
  })
})

describe('ページ', () => {
  function three() {
    const pages = ['A', 'B', 'C'].map((name) => createPage(name))
    const doc: DesignDocument = { name: 'doc', pages, assets: {}, fonts: [], collections: [] }
    const names = (d: typeof doc) => d.pages.map((page) => page.name).join('')
    return { doc, ids: pages.map((page) => page.id), names }
  }

  it('新しいドキュメントには 1 ページある', () => {
    expect(createDocument().pages).toHaveLength(1)
  })

  it('1 ページだけを書き換え、変わらなければ同じドキュメントを返す', () => {
    const { doc, ids } = three()
    const rect = createRect(bounds)
    const next = updatePage(doc, ids[1], (page) => insertNode(page, rect))
    expect(next.pages[1].rootIds).toEqual([rect.id])
    expect(next.pages[0]).toBe(doc.pages[0])

    expect(updatePage(doc, ids[1], (page) => page)).toBe(doc)
    expect(updatePage(doc, 'missing', (page) => insertNode(page, rect))).toBe(doc)
    expect(renamePage(doc, ids[0], 'A')).toBe(doc)
    expect(renamePage(doc, ids[0], 'Z').pages[0].name).toBe('Z')
  })

  it('追加・削除・並べ替え', () => {
    const { doc, ids, names } = three()
    expect(names(addPage(doc, createPage('D')))).toBe('ABCD')
    expect(names(addPage(doc, createPage('D'), 1))).toBe('ADBC')
    expect(() => addPage(doc, doc.pages[0])).toThrow()

    expect(names(removePage(doc, ids[1]))).toBe('AC')
    expect(removePage(doc, 'missing')).toBe(doc)

    expect(names(movePage(doc, ids[0], 2))).toBe('BCA')
    expect(names(movePage(doc, ids[2], 0))).toBe('CAB')
    expect(movePage(doc, ids[1], 1)).toBe(doc)
  })

  it('最後の 1 ページは消せない', () => {
    const doc = createDocument()
    expect(removePage(doc, doc.pages[0].id)).toBe(doc)
  })

  it('複製は中身ごと新しい id で作り、元のすぐ後ろに置く', () => {
    const { doc, ids, names } = three()
    const { doc: scene, frame } = fixture()
    const filled = updatePage(doc, ids[0], (page) => ({ ...page, nodes: scene.nodes, rootIds: scene.rootIds }))

    const result = duplicatePage(filled, ids[0])!
    expect(names(result.document)).toBe('AA のコピーBC')
    const copy = result.document.pages[1]
    expect(copy.id).toBe(result.pageId)
    expect(Object.keys(copy.nodes)).toHaveLength(Object.keys(scene.nodes).length)
    expect(Object.keys(copy.nodes)).not.toContain(frame.id)
    expect(copy.nodes[copy.rootIds[0]]).toMatchObject({ type: 'frame', x: 100, y: 50 })
    expect(duplicatePage(doc, 'missing')).toBeNull()
  })

  it('ノードを子孫ごと別のページへ移す。id はそのままで、ページ上の位置を保ってページ直下の最前面に置く', () => {
    const { doc, ids } = three()
    const { doc: scene, frame, inner, rect } = fixture()
    const other = createRect(bounds)
    let filled = updatePage(doc, ids[0], (page) => ({ ...page, nodes: scene.nodes, rootIds: scene.rootIds }))
    filled = updatePage(filled, ids[1], (page) => insertNode(page, other))

    const next = moveNodesToPage(filled, ids[0], [inner.id, rect.id], ids[1])
    const [a, b] = next.pages
    expect(Object.keys(a.nodes)).not.toContain(inner.id)
    expect(a.nodes[frame.id]).toMatchObject({ children: [] })
    expect(b.rootIds).toEqual([other.id, inner.id])
    // フレーム (100, 50) の中の (20, 10) は、ページ上の (120, 60)
    expect(b.nodes[inner.id]).toMatchObject({ parentId: null, x: 120, y: 60, children: [rect.id] })
    expect(b.nodes[rect.id]).toMatchObject({ parentId: inner.id, x: 5, y: 5 })

    expect(moveNodesToPage(filled, ids[0], [inner.id], ids[0])).toBe(filled)
    expect(moveNodesToPage(filled, ids[0], ['missing'], ids[1])).toBe(filled)
    expect(moveNodesToPage(filled, ids[0], [inner.id], 'missing')).toBe(filled)
  })
})
