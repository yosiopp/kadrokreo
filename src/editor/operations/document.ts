import { sha256Hex } from '../../document/sha256.ts'
import type { Asset, AssetId, DesignDocument, NodeId, Page, PageId } from '../../document/types.ts'
import { createId } from '../nodes.ts'
import { type Fragment, copyFragment, pasteFragment } from './clipboard.ts'

// ドキュメント・ページ・アセットの操作。どれも新しいドキュメントを返し、変化がなければ同じ参照を返す

export function createPage(name = 'Page 1'): Page {
  return { id: createId(), name, nodes: {}, rootIds: [] }
}

export function createDocument(name = 'Untitled'): DesignDocument {
  return { name, pages: [createPage()], assets: {} }
}

export function renameDocument(doc: DesignDocument, name: string): DesignDocument {
  return name === doc.name ? doc : { ...doc, name }
}

/** 1 ページだけを書き換える。recipe が同じページを返したら、ドキュメントも同じものを返す */
export function updatePage(
  doc: DesignDocument,
  pageId: PageId,
  recipe: (page: Page) => Page,
): DesignDocument {
  const index = doc.pages.findIndex((page) => page.id === pageId)
  if (index === -1) return doc
  const next = recipe(doc.pages[index])
  return next === doc.pages[index] ? doc : { ...doc, pages: doc.pages.with(index, next) }
}

export function renamePage(doc: DesignDocument, pageId: PageId, name: string): DesignDocument {
  return updatePage(doc, pageId, (page) => (page.name === name ? page : { ...page, name }))
}

/** index を省略すると末尾に足す */
export function addPage(doc: DesignDocument, page: Page, index = doc.pages.length): DesignDocument {
  if (doc.pages.some((other) => other.id === page.id)) throw new Error(`page already exists: ${page.id}`)
  return { ...doc, pages: doc.pages.toSpliced(index, 0, page) }
}

/** ドキュメントには必ず 1 ページ残す */
export function removePage(doc: DesignDocument, pageId: PageId): DesignDocument {
  if (doc.pages.length <= 1 || !doc.pages.some((page) => page.id === pageId)) return doc
  return { ...doc, pages: doc.pages.filter((page) => page.id !== pageId) }
}

/** index は自分を取り除いた後の並びでの位置 */
export function movePage(doc: DesignDocument, pageId: PageId, index: number): DesignDocument {
  const from = doc.pages.findIndex((page) => page.id === pageId)
  if (from === -1) return doc
  const pages = doc.pages.toSpliced(from, 1).toSpliced(index, 0, doc.pages[from])
  return pages.every((page, i) => page === doc.pages[i]) ? doc : { ...doc, pages }
}

/** 中身ごと複製して、元のページのすぐ後ろに置く。ノードの id は振り直す */
export function duplicatePage(
  doc: DesignDocument,
  pageId: PageId,
): { document: DesignDocument; pageId: PageId } | null {
  const index = doc.pages.findIndex((page) => page.id === pageId)
  if (index === -1) return null
  const source = doc.pages[index]
  const fragment = copyFragment(source, doc.assets, source.rootIds)
  const copy = pasteFragment(createPage(`${source.name} のコピー`), fragment).scene
  return { document: addPage(doc, copy, index + 1), pageId: copy.id }
}

export function addAsset(doc: DesignDocument, id: AssetId, asset: Asset): DesignDocument {
  return { ...doc, assets: { ...doc.assets, [id]: asset } }
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/** 中身（形式とバイト列）が同じアセットの id。なければ null */
export function findSameAsset(assets: Record<AssetId, Asset>, asset: Asset): AssetId | null {
  for (const [id, existing] of Object.entries(assets)) {
    // 長さが違えば中身を比べるまでもない。同じ長さのときだけ全体を比べる
    if (existing.mime === asset.mime && sameBytes(existing.bytes, asset.bytes)) return id
  }
  return null
}

/**
 * 画像を取り込むときのアセットの追加。id は中身の SHA-256 にする。中身が同じアセットがすでにあれば、新しく足さずにその id を使う
 * （同じ画像を何度置いても kdr が大きくならない）。
 * kdr の画像の名前がハッシュと合うかは読むときに確かめないので、同じ id で中身の違うアセットがありうる。そのときは newId で足す
 */
export function addOrReuseAsset(
  doc: DesignDocument,
  asset: Asset,
  newId: () => AssetId,
): { document: DesignDocument; assetId: AssetId } {
  const same = findSameAsset(doc.assets, asset)
  if (same !== null) return { document: doc, assetId: same }
  const hash = sha256Hex(asset.bytes)
  const assetId = Object.hasOwn(doc.assets, hash) ? newId() : hash
  return { document: addAsset(doc, assetId, asset), assetId }
}

/** どのノードからも使われていないアセットを除く。保存や書き出しの前に呼ぶ */
export function pruneAssets(doc: DesignDocument): DesignDocument {
  const used = new Set<AssetId>()
  for (const page of doc.pages) {
    for (const node of Object.values(page.nodes)) {
      if (node.type === 'image') used.add(node.assetId)
      // 上書きが指す画像も残す。kdr を読むときに、その画像がファイルにあることを確かめている
      if (node.type === 'frame' && node.component?.role === 'instance') {
        for (const override of Object.values(node.component.overrides)) {
          if (override.assetId !== undefined) used.add(override.assetId)
        }
      }
    }
  }
  const ids = Object.keys(doc.assets)
  if (ids.every((id) => used.has(id))) return doc
  return { ...doc, assets: Object.fromEntries(ids.filter((id) => used.has(id)).map((id) => [id, doc.assets[id]])) }
}

/** ページへ貼り付け、足りないアセットをドキュメントに足す */
export function pasteIntoPage(
  doc: DesignDocument,
  pageId: PageId,
  fragment: Fragment,
  offset = 0,
): { document: DesignDocument; ids: NodeId[] } {
  let ids: NodeId[] = []
  const pasted = updatePage(doc, pageId, (page) => {
    const result = pasteFragment(page, fragment, offset)
    ids = result.ids
    return result.scene
  })
  // 同じ id のアセットは中身も同じなので、すでにあるものはそのまま使う
  const missing = Object.keys(fragment.assets).some((id) => !Object.hasOwn(doc.assets, id))
  const document = missing ? { ...pasted, assets: { ...fragment.assets, ...doc.assets } } : pasted
  return { document, ids }
}
