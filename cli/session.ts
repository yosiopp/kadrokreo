import { KDR_FORMAT, KDR_VERSION, parseKdr } from '../src/document/kdr.ts'
import type { Asset, DesignDocument, FrameNode, NodeId, Page, Scene, SceneNode } from '../src/document/types.ts'
import { createEditorStore } from '../src/editor/store.ts'
import { updatePage } from '../src/editor/operations.ts'
import { UsageError } from './args.ts'
import { fitTextEstimated } from './textMeasure.ts'

// 1 回の実行で扱うドキュメントと、コマンドをまたいで覚えておくもの（いまのページ、直前に作ったノード）。
// 変更の後始末（インスタンスの中身への変更を上書きとして覚える・自動で並べ直す・インスタンスを元に合わせる）は、
// editor と同じ結果になるよう、editor のストアにそのまま任せる。

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

export class Session {
  #store
  #pageId: string
  /** 直前のコマンドで作ったノード。セレクタの「@」で指す */
  last: NodeId[] = []
  /** ドキュメントを変えるコマンドを実行したか */
  modified = false

  constructor(document: DesignDocument) {
    this.#store = createEditorStore(document, fitTextEstimated)
    this.#pageId = document.pages[0].id
  }

  get document(): DesignDocument {
    return this.#store.getState().document
  }

  get page(): Page {
    return this.document.pages.find((page) => page.id === this.#pageId) ?? this.document.pages[0]
  }

  setPage(id: string): void {
    this.#pageId = id
  }

  /**
   * ドキュメントを変える。editor と同じ後始末を通したあと、kdr として正しいかを確かめる。
   * 正しくなければ（色の書式が違うなど）、変更を捨てて KdrError を投げる。
   */
  applyDocument(recipe: (doc: DesignDocument) => DesignDocument): void {
    const before = this.document
    this.#store.applyDocument(recipe)
    const after = this.document
    if (after === before) return
    // 壊れた変更を残さないよう、検証できたものだけをストアに入れ直す
    let checked: DesignDocument
    try {
      checked = validate(after)
    } catch (error) {
      this.#store.load(before)
      throw error
    }
    this.#store.load(checked)
    if (!this.document.pages.some((page) => page.id === this.#pageId)) this.#pageId = this.document.pages[0].id
    this.modified = true
  }

  /** いまのページを変える */
  apply(recipe: (page: Page) => Page): void {
    this.applyDocument((doc) => updatePage(doc, this.page.id, recipe))
  }

  /** セレクタ 1 つを、いまのページのノード（複数のこともある）にする */
  resolve(selector: string): NodeId[] {
    return resolveSelector(this.page, selector, this.last)
  }

  resolveOne(selector: string): NodeId {
    const ids = this.resolve(selector)
    if (ids.length !== 1) throw new UsageError(`${selector}: 1 つのノードを指定してください（${ids.length} 個あります）`)
    return ids[0]
  }

  resolveAll(selectors: readonly string[]): NodeId[] {
    if (selectors.length === 0) throw new UsageError('ノードを指定してください')
    return [...new Set(selectors.flatMap((selector) => this.resolve(selector)))]
  }

  resolveFrame(selector: string): NodeId {
    const id = this.resolveOne(selector)
    if (this.page.nodes[id].type !== 'frame') throw new UsageError(`${selector}: フレームではありません`)
    return id
  }
}

/**
 * セレクタ:
 *   @            直前のコマンドで作ったノード
 *   ID           ノードの id
 *   名前         レイヤー名（同じ名前が複数あるとエラー）
 *   親/子        レイヤー名か id を / でつないだ道筋（親子が続いていること。先頭はどの深さからでもよい）
 */
export function resolveSelector(scene: Scene, selector: string, last: readonly NodeId[] = []): NodeId[] {
  if (selector === '@') {
    const alive = last.filter((id) => Object.hasOwn(scene.nodes, id))
    if (alive.length === 0) throw new UsageError('@: 直前に作ったノードがありません')
    return alive
  }
  if (Object.hasOwn(scene.nodes, selector)) return [selector]

  const names = selector.split('/')
  const matches = Object.values(scene.nodes).filter((node) => {
    let current: SceneNode | undefined = node
    for (let i = names.length - 1; i >= 0; i--) {
      if (current === undefined || (current.name !== names[i] && current.id !== names[i])) return false
      current = current.parentId === null ? undefined : scene.nodes[current.parentId]
    }
    return true
  })
  if (matches.length === 0) throw new UsageError(`${selector}: ノードが見つかりません`)
  if (matches.length > 1) {
    const list = matches.map((node) => node.id).join(', ')
    throw new UsageError(`${selector}: 同じ名前のノードが ${matches.length} 個あります。id で指定してください（${list}）`)
  }
  return [matches[0].id]
}

/** ページのセレクタ: id、名前、1 から数えた番号の順に探す */
export function resolvePage(doc: DesignDocument, selector: string): Page {
  const found =
    doc.pages.find((page) => page.id === selector) ??
    doc.pages.find((page) => page.name === selector) ??
    (/^\d+$/.test(selector) ? doc.pages[Number(selector) - 1] : undefined)
  if (!found) throw new UsageError(`ページが見つかりません: ${selector}`)
  return found
}

export function checkNewId(scene: Scene, id: string): void {
  if (!ID_PATTERN.test(id)) throw new UsageError(`id には英数字と _ - だけを 64 文字まで使えます: ${id}`)
  if (Object.hasOwn(scene.nodes, id)) throw new UsageError(`id が重複しています: ${id}`)
}

/** ノードの id を付け替える（親の children と、ページ直下の並びも直す） */
export function renameNodeId<T extends Scene>(scene: T, from: NodeId, to: NodeId): T {
  if (from === to) return scene
  checkNewId(scene, to)
  const nodes: Record<NodeId, SceneNode> = {}
  for (const [id, node] of Object.entries(scene.nodes)) {
    let next: SceneNode = id === from ? { ...node, id: to } : node
    if (next.parentId === from) next = { ...next, parentId: to }
    if (next.type === 'frame' && next.children.includes(from)) {
      next = { ...next, children: next.children.map((child) => (child === from ? to : child)) } satisfies FrameNode
    }
    nodes[id === from ? to : id] = next
  }
  return { ...scene, nodes, rootIds: scene.rootIds.map((id) => (id === from ? to : id)) }
}

/**
 * kdr として読み込める形かを確かめ、読み込んだときと同じ形（既知の項目だけ）に組み直す。
 * 画像のデータは読み込み時か追加時に確かめてあるので、ここでは中身を省いて速くする。
 */
export function validate(doc: DesignDocument): DesignDocument {
  const placeholders: Record<string, Asset> = {}
  for (const [id, asset] of Object.entries(doc.assets)) placeholders[id] = { mime: asset.mime, data: '' }
  const json = JSON.stringify({ format: KDR_FORMAT, version: KDR_VERSION, document: { ...doc, assets: placeholders } })
  return { ...parseKdr(JSON.parse(json)), assets: doc.assets }
}
