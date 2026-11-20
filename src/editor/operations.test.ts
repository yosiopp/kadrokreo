import { describe, expect, it } from 'vitest'
import type { FrameNode } from '../document/types.ts'
import { createFrame, createImage, createLine, createRect, createText } from './nodes.ts'
import { getAbsolutePosition } from '../document/geometry.ts'
import {
  addAsset,
  alignNodes,
  copyFragment,
  createDocument,
  distributeNodes,
  insertNode,
  moveNode,
  pasteFragment,
  placeNodes,
  pruneAssets,
  removeNodes,
  reorderNodes,
  reparentNodes,
  resizeNodes,
  topLevelIds,
  translateNodes,
  updateNode,
} from './operations.ts'

const bounds = { x: 0, y: 0, width: 100, height: 100 }

function fixture() {
  const frame = createFrame({ x: 100, y: 50, width: 400, height: 300 })
  const inner = createFrame({ x: 20, y: 10, width: 200, height: 100 })
  const rect = createRect({ x: 5, y: 5, width: 10, height: 10 })
  const loose = createRect({ ...bounds, x: 900 })
  let doc = createDocument()
  doc = insertNode(doc, frame)
  doc = insertNode(doc, inner, frame.id)
  doc = insertNode(doc, rect, inner.id)
  doc = insertNode(doc, loose)
  return { doc, frame, inner, rect, loose }
}

describe('insertNode', () => {
  it('ページ直下では最前面に追加する', () => {
    const { doc, frame, loose } = fixture()
    expect(doc.rootIds).toEqual([frame.id, loose.id])
    expect(doc.nodes[loose.id].parentId).toBeNull()
  })

  it('フレームの子として指定位置に追加する', () => {
    const { doc, frame, inner } = fixture()
    const back = createRect(bounds)
    const next = insertNode(doc, back, frame.id, 0)
    expect((next.nodes[frame.id] as FrameNode).children).toEqual([back.id, inner.id])
    expect(next.nodes[back.id].parentId).toBe(frame.id)
  })

  it('元のドキュメントを書き換えない', () => {
    const { doc, frame } = fixture()
    const before = structuredClone(doc)
    insertNode(doc, createRect(bounds), frame.id)
    expect(doc).toEqual(before)
  })

  it('フレーム以外を親にはできない', () => {
    const { doc, loose } = fixture()
    expect(() => insertNode(doc, createRect(bounds), loose.id)).toThrow()
  })

  it('同じ id は二重に追加できない', () => {
    const { doc, loose } = fixture()
    expect(() => insertNode(doc, loose)).toThrow()
  })
})

describe('updateNode', () => {
  it('指定したフィールドだけを更新する', () => {
    const { doc, rect } = fixture()
    const next = updateNode(doc, rect.id, { x: 42, fill: '#ff0000' })
    expect(next.nodes[rect.id]).toEqual({ ...doc.nodes[rect.id], x: 42, fill: '#ff0000' })
  })

  it('値が変わらなければ同じドキュメントを返す', () => {
    const { doc, rect } = fixture()
    expect(updateNode(doc, rect.id, { x: rect.x })).toBe(doc)
    expect(updateNode(doc, 'missing', { x: 1 })).toBe(doc)
  })

  it('木構造のフィールドやノード種別にないフィールドは無視する', () => {
    const { doc, rect } = fixture()
    const patch = { parentId: null, id: 'other', text: 'hello' } as object
    expect(updateNode(doc, rect.id, patch)).toBe(doc)
  })
})

describe('removeNodes', () => {
  it('子孫ごと削除し、親の children からも外す', () => {
    const { doc, frame, inner, rect, loose } = fixture()
    const next = removeNodes(doc, [inner.id])
    expect(Object.keys(next.nodes).sort()).toEqual([frame.id, loose.id].sort())
    expect((next.nodes[frame.id] as FrameNode).children).toEqual([])
    expect(next.nodes[rect.id]).toBeUndefined()
  })

  it('親子を同時に指定しても壊れない', () => {
    const { doc, frame, rect, loose } = fixture()
    const next = removeNodes(doc, [rect.id, frame.id])
    expect(next.rootIds).toEqual([loose.id])
    expect(Object.keys(next.nodes)).toEqual([loose.id])
  })

  it('対象がなければ同じドキュメントを返す', () => {
    const { doc } = fixture()
    expect(removeNodes(doc, ['missing'])).toBe(doc)
  })
})

describe('moveNode', () => {
  it('親を付け替えても見た目の位置を保つ', () => {
    const { doc, rect } = fixture()
    expect(getAbsolutePosition(doc, rect.id)).toEqual({ x: 125, y: 65 })

    const next = moveNode(doc, rect.id, null)
    expect(next.nodes[rect.id]).toMatchObject({ parentId: null, x: 125, y: 65 })
    expect(next.rootIds.at(-1)).toBe(rect.id)
  })

  it('別のフレームの中へ移せる', () => {
    const { doc, frame, inner, loose } = fixture()
    const next = moveNode(doc, loose.id, inner.id, 0)
    expect(next.rootIds).toEqual([frame.id])
    expect((next.nodes[inner.id] as FrameNode).children[0]).toBe(loose.id)
    expect(getAbsolutePosition(next, loose.id)).toEqual({ x: 900, y: 0 })
  })

  it('同じ親の中で重なり順を変えられる', () => {
    const { doc, frame, loose } = fixture()
    const next = moveNode(doc, loose.id, null, 0)
    expect(next.rootIds).toEqual([loose.id, frame.id])
    expect(moveNode(doc, loose.id, null, 1)).toBe(doc)
  })

  it('自分自身や子孫の中へは移せない', () => {
    const { doc, frame, inner } = fixture()
    expect(() => moveNode(doc, frame.id, frame.id)).toThrow()
    expect(() => moveNode(doc, frame.id, inner.id)).toThrow()
  })

  it('フレーム以外の中へは移せない', () => {
    const { doc, rect, loose } = fixture()
    expect(() => moveNode(doc, rect.id, loose.id)).toThrow()
    expect(() => moveNode(doc, rect.id, createText(bounds).id)).toThrow()
  })
})

describe('translateNodes', () => {
  it('親子を一緒に指定しても子が二重に動かない', () => {
    const { doc, frame, rect } = fixture()
    expect(topLevelIds(doc, [rect.id, frame.id, 'missing'])).toEqual([frame.id])

    const next = translateNodes(doc, [frame.id, rect.id], 10, -5)
    expect(next.nodes[frame.id]).toMatchObject({ x: 110, y: 45 })
    expect(next.nodes[rect.id]).toMatchObject({ x: 5, y: 5 })
    expect(translateNodes(doc, [frame.id], 0, 0)).toBe(doc)
  })
})

describe('resizeNodes', () => {
  it('選択範囲に合わせて位置と大きさを拡大縮小する', () => {
    const a = createRect({ x: 0, y: 0, width: 100, height: 100 })
    const b = createRect({ x: 100, y: 100, width: 100, height: 100 })
    let doc = createDocument()
    doc = insertNode(doc, a)
    doc = insertNode(doc, b)

    const from = { x: 0, y: 0, width: 200, height: 200 }
    const next = resizeNodes(doc, [a.id, b.id], from, { x: 0, y: 0, width: 400, height: 100 })
    expect(next.nodes[a.id]).toMatchObject({ x: 0, y: 0, width: 200, height: 50 })
    expect(next.nodes[b.id]).toMatchObject({ x: 200, y: 50, width: 200, height: 50 })
  })

  it('フレームの子は動かさず、子の位置は親からの相対で保つ', () => {
    const { doc, frame, inner } = fixture()
    const from = { x: 100, y: 50, width: 400, height: 300 }
    const next = resizeNodes(doc, [frame.id], from, { x: 150, y: 50, width: 350, height: 300 })
    expect(next.nodes[frame.id]).toMatchObject({ x: 150, width: 350 })
    expect(next.nodes[inner.id]).toBe(doc.nodes[inner.id])
  })

  it('直線は高さ 0 のまま伸び縮みできる', () => {
    const line = createLine({ x: 0, y: 50, width: 100, height: 0 })
    const doc = insertNode(createDocument(), line)
    const from = { x: 0, y: 50, width: 100, height: 0 }
    const next = resizeNodes(doc, [line.id], from, { x: 0, y: 50, width: 250, height: 1 })
    expect(next.nodes[line.id]).toMatchObject({ x: 0, y: 50, width: 250, height: 0 })
  })

  it('テキストは幅を変えると折り返しになり、高さは変えない', () => {
    const text = createText({ x: 100, y: 100, width: 40, height: 20 }, 'abc')
    const doc = insertNode(createDocument(), text)
    const from = { x: 0, y: 0, width: 200, height: 200 }

    const wider = resizeNodes(doc, [text.id], from, { x: 0, y: 0, width: 400, height: 400 })
    expect(wider.nodes[text.id]).toMatchObject({ x: 200, y: 200, width: 80, height: 20, autoWidth: false })

    const taller = resizeNodes(doc, [text.id], from, { x: 0, y: 0, width: 200, height: 400 })
    expect(taller.nodes[text.id]).toMatchObject({ x: 100, y: 200, width: 40, height: 20, autoWidth: true })
  })
})

describe('reparentNodes', () => {
  it('親が違うノードだけを移す', () => {
    const { doc, frame, inner, rect, loose } = fixture()
    const next = reparentNodes(doc, [loose.id, rect.id], frame.id)
    expect((next.nodes[frame.id] as FrameNode).children).toEqual([inner.id, rect.id, loose.id])
    expect(getAbsolutePosition(next, loose.id)).toEqual({ x: 900, y: 0 })
    expect(reparentNodes(doc, [inner.id], frame.id)).toBe(doc)
    // 自分自身の中へは入れない
    expect(reparentNodes(doc, [frame.id], inner.id)).toBe(doc)
  })
})

describe('placeNodes', () => {
  function flat() {
    const nodes = ['a', 'b', 'c', 'd'].map((name) => ({ ...createRect(bounds), name }))
    const doc = nodes.reduce((next, node) => insertNode(next, node), createDocument())
    const names = (d: typeof doc) => d.rootIds.map((id) => d.nodes[id].name).join('')
    return { doc, ids: nodes.map((node) => node.id), names }
  }

  it('複数ノードを互いの順序を保ったまま target の手前・奥へ移す', () => {
    const { doc, ids, names } = flat()
    const [a, b, c, d] = ids
    expect(names(placeNodes(doc, [a, b], d, 'above'))).toBe('cdab')
    expect(names(placeNodes(doc, [b, a], d, 'below'))).toBe('cabd')
    expect(names(placeNodes(doc, [c, d], a, 'below'))).toBe('cdab')
    expect(names(placeNodes(doc, [d], b, 'above'))).toBe('abdc')
  })

  it('フレームの中へ入れる', () => {
    const { doc, frame, inner, loose } = fixture()
    const next = placeNodes(doc, [loose.id], frame.id, 'inside')
    expect((next.nodes[frame.id] as FrameNode).children).toEqual([inner.id, loose.id])
  })

  it('自分自身や子孫を基準にした移動、フレーム以外の中への移動は何もしない', () => {
    const { doc, frame, inner, rect, loose } = fixture()
    expect(placeNodes(doc, [frame.id], inner.id, 'inside')).toBe(doc)
    expect(placeNodes(doc, [frame.id], rect.id, 'above')).toBe(doc)
    expect(placeNodes(doc, [rect.id], loose.id, 'inside')).toBe(doc)
  })

  it('重なり順を 1 つずつ、または端まで動かす', () => {
    const { doc, ids, names } = flat()
    const [a, b, c, d] = ids
    expect(names(reorderNodes(doc, [a, c], 'front'))).toBe('bdac')
    expect(names(reorderNodes(doc, [b, d], 'back'))).toBe('bdac')
    expect(names(reorderNodes(doc, [a, b], 'forward'))).toBe('cabd')
    expect(names(reorderNodes(doc, [c, d], 'forward'))).toBe('abcd')
    expect(names(reorderNodes(doc, [b], 'backward'))).toBe('bacd')
    expect(reorderNodes(doc, [a], 'backward')).toBe(doc)
  })
})

describe('copyFragment / pasteFragment', () => {
  it('子孫ごと新しい id で複製し、元の親の中へずらして置く', () => {
    const { doc, frame, inner, rect } = fixture()
    const { document: next, ids } = pasteFragment(doc, copyFragment(doc, [inner.id, rect.id]), 10)

    expect(ids).toHaveLength(1)
    const copy = next.nodes[ids[0]] as FrameNode
    expect(copy.id).not.toBe(inner.id)
    expect(copy).toMatchObject({ parentId: frame.id, x: 30, y: 20 })
    expect((next.nodes[frame.id] as FrameNode).children).toEqual([inner.id, copy.id])

    expect(copy.children).toHaveLength(1)
    expect(copy.children[0]).not.toBe(rect.id)
    expect(next.nodes[copy.children[0]]).toMatchObject({ parentId: copy.id, x: 5, y: 5 })
    expect(Object.keys(next.nodes)).toHaveLength(6)
  })

  it('元の親が消えていたらページ直下へ、見た目の位置を保って置く', () => {
    const { doc, frame, rect } = fixture()
    const fragment = copyFragment(doc, [rect.id])
    const { document: next, ids } = pasteFragment(removeNodes(doc, [frame.id]), fragment)
    expect(next.nodes[ids[0]]).toMatchObject({ parentId: null, x: 125, y: 65 })
    expect(next.rootIds.at(-1)).toBe(ids[0])
  })
})

describe('alignNodes', () => {
  function three() {
    const nodes = [
      createRect({ x: 0, y: 0, width: 20, height: 20 }),
      createRect({ x: 50, y: 30, width: 40, height: 10 }),
      createRect({ x: 200, y: 80, width: 100, height: 20 }),
    ]
    const doc = nodes.reduce((next, node) => insertNode(next, node), createDocument())
    const ids = nodes.map((node) => node.id)
    const xs = (d: typeof doc) => ids.map((id) => d.nodes[id].x)
    const ys = (d: typeof doc) => ids.map((id) => d.nodes[id].y)
    return { doc, ids, xs, ys }
  }

  it('複数選択は選択範囲に揃える', () => {
    const { doc, ids, xs, ys } = three()
    expect(xs(alignNodes(doc, ids, 'left'))).toEqual([0, 0, 0])
    expect(xs(alignNodes(doc, ids, 'right'))).toEqual([280, 260, 200])
    expect(xs(alignNodes(doc, ids, 'center'))).toEqual([140, 130, 100])
    expect(ys(alignNodes(doc, ids, 'top'))).toEqual([0, 0, 0])
    expect(ys(alignNodes(doc, ids, 'bottom'))).toEqual([80, 90, 80])
    expect(ys(alignNodes(doc, ids, 'middle'))).toEqual([40, 45, 40])
  })

  it('1 つだけなら親フレームに揃え、ページ直下では何もしない', () => {
    const { doc, frame, inner, loose } = fixture()
    expect(alignNodes(doc, [inner.id], 'right').nodes[inner.id]).toMatchObject({ x: 200, y: 10 })
    expect(alignNodes(doc, [inner.id], 'middle').nodes[inner.id]).toMatchObject({ x: 20, y: 100 })
    expect(alignNodes(doc, [loose.id], 'left')).toBe(doc)
    expect(alignNodes(doc, [frame.id], 'left')).toBe(doc)
  })

  it('等間隔に並べる', () => {
    const { doc, ids, xs, ys } = three()
    // 幅 20 + 40 + 100、全体 300 なので間隔は 70
    expect(xs(distributeNodes(doc, ids, 'x'))).toEqual([0, 90, 200])
    expect(ys(distributeNodes(doc, ids, 'y'))).toEqual([0, 45, 80])
    expect(distributeNodes(doc, ids.slice(0, 2), 'x')).toBe(doc)
  })
})

describe('assets', () => {
  const asset = { mime: 'image/png', data: 'AAAA' }

  it('使われていないアセットを除く', () => {
    const image = createImage(bounds, 'a')
    const doc = insertNode(addAsset(addAsset(createDocument(), 'a', asset), 'b', asset), image)
    expect(pruneAssets(doc).assets).toEqual({ a: asset })

    const clean = addAsset(insertNode(createDocument(), image), 'a', asset)
    expect(pruneAssets(clean)).toBe(clean)
  })

  it('コピーしたノードは、アセットのない別のドキュメントへ貼っても画像が欠けない', () => {
    const image = createImage(bounds, 'a')
    const source = insertNode(addAsset(createDocument(), 'a', asset), image)
    const fragment = copyFragment(source, [image.id])
    expect(fragment.assets).toEqual({ a: asset })

    const { document: pasted, ids } = pasteFragment(createDocument(), fragment)
    expect(pasted.assets).toEqual({ a: asset })
    expect(pasted.nodes[ids[0]]).toMatchObject({ type: 'image', assetId: 'a' })

    // 同じドキュメント内なら assets は作り直さない
    expect(pasteFragment(source, fragment).document.assets).toBe(source.assets)
  })
})
