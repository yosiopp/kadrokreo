import { KDR_VERSION, kdrFile, parseKdr } from '../document/kdr.ts'
import type { AssetId, DesignDocument, NodeId, SceneNode } from '../document/types.ts'
import { pruneAssets } from './operations/document.ts'

// 編集中のドキュメントはブラウザの IndexedDB に自動保存する。
// 画像は大きいので別のストアに分け、一度書いたものは書き直さない（id は中身のハッシュなので、同じ id なら中身も同じ）。
// 画像は { mime, bytes }（バイト列）のまま保存する（v15 までは base64 の文字列だった）。
// ドキュメントはメモリ上の形（平らなノードの表）のまま保存し、読むときに kdr の形へ直して parseKdr で検証する。
// ノードの表は CHUNK_NODES 個ずつに分け、ページの表を空にしたドキュメント（'current'）とは別のレコード（['nodes', 番号]）に書く。
// IndexedDB は put のたびに値をその場で写す（大きなドキュメントを 1 回で写すと、large で 20〜40ms メインスレッドが止まる）ので、
// 1 つのトランザクションのまま、前の分が書けてから（別のタスクで）次の分を写し、長く止まらないようにする。画像も 1 枚ずつ同じように書く。
// 途中で閉じたり失敗したりしたら、トランザクションごと書かれない（前の保存が残る）。
// kdr の version が違う保存データ（古い形）は読めないので、画像ごと捨てて空のドキュメントから始める。
const DB_NAME = 'kadrokreo'
const DOCUMENT_STORE = 'document'
const ASSET_STORE = 'assets'
const CURRENT = 'current'
/** ノードの表を分けて書くときの、1 つのレコードのノードの数（写すのに 1〜2ms ほど） */
const CHUNK_NODES = 1000
/** 分けたノードの表のレコードの、番号が from 以上のもの（キーは ['nodes', 番号]） */
const chunkRange = (from: number) => IDBKeyRange.bound(['nodes', from], ['nodes', Infinity])

/** 分けて書いたノードの表の 1 つ。page はページの並びの番号 */
type NodeChunk = { page: number; nodes: Record<NodeId, SceneNode> }

let database: Promise<IDBDatabase> | null = null
/** IndexedDB に書き込み済みのアセット */
const savedAssets = new Set<AssetId>()

function openDatabase(): Promise<IDBDatabase> {
  database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1)
    request.onupgradeneeded = () => {
      request.result.createObjectStore(DOCUMENT_STORE)
      request.result.createObjectStore(ASSET_STORE)
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  return database
}

function result<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

function completed(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error)
  })
}

export async function loadSavedDocument(): Promise<DesignDocument | null> {
  try {
    const db = await openDatabase()
    const transaction = db.transaction([DOCUMENT_STORE, ASSET_STORE], 'readonly')
    const assetStore = transaction.objectStore(ASSET_STORE)
    const documentStore = transaction.objectStore(DOCUMENT_STORE)
    const [file, chunks, ids, assets] = await Promise.all([
      result(documentStore.get(CURRENT)),
      result(documentStore.getAll(chunkRange(0)) as IDBRequest<NodeChunk[]>),
      result(assetStore.getAllKeys()),
      result(assetStore.getAll() as IDBRequest<unknown[]>),
    ])
    if (file === undefined) return null

    if (file?.version !== KDR_VERSION) {
      // 古い形の保存データ（base64 の画像など）は読めない。残しておいても使わないので消す
      await clearAll(db)
      return null
    }
    // 画像の形は parseKdr が確かめる（壊れたもの・古い形のものがあれば、読み込みごと失敗して空から始める）
    const stored = Object.fromEntries(ids.map((id, i) => [String(id), assets[i]]))
    const doc = pruneAssets(parseKdr(kdrFile(joinChunks(file, chunks)), stored))

    // 削除された画像のデータはここで片付ける（編集中は Undo で戻せるよう残してある）
    const orphans = ids.filter((id) => !Object.hasOwn(doc.assets, String(id)))
    if (orphans.length > 0) {
      const cleanup = db.transaction(ASSET_STORE, 'readwrite')
      for (const id of orphans) cleanup.objectStore(ASSET_STORE).delete(id)
    }
    savedAssets.clear()
    for (const id of Object.keys(doc.assets)) savedAssets.add(id)
    return doc
  } catch {
    // 壊れた保存データや IndexedDB が使えない環境では、空のドキュメントから始める
    return null
  }
}

/**
 * 分けて書いたノードの表を、ページに戻したドキュメント。分けていない保存データ（chunks が無い）はそのまま。
 * 表は Object.fromEntries で作る（代入で組むと、__proto__ という id でプロトタイプが変わってしまう）。形の誤りは parseKdr が見つける
 */
function joinChunks(file: { chunks?: unknown; document: DesignDocument }, chunks: NodeChunk[]): DesignDocument {
  if (typeof file.chunks !== 'number') return file.document
  const parts = chunks.slice(0, file.chunks)
  return {
    ...file.document,
    pages: file.document.pages.map((page, index) => ({
      ...page,
      nodes: Object.fromEntries(parts.filter((chunk) => chunk.page === index).flatMap((chunk) => Object.entries(chunk.nodes))),
    })),
  }
}

async function clearAll(db: IDBDatabase): Promise<void> {
  const transaction = db.transaction([DOCUMENT_STORE, ASSET_STORE], 'readwrite')
  transaction.objectStore(DOCUMENT_STORE).clear()
  transaction.objectStore(ASSET_STORE).clear()
  await completed(transaction)
  savedAssets.clear()
}

/** 保存できたかどうかを返す */
export async function saveDocument(doc: DesignDocument): Promise<boolean> {
  try {
    const db = await openDatabase()
    const pruned = pruneAssets(doc)
    const transaction = db.transaction([DOCUMENT_STORE, ASSET_STORE], 'readwrite')
    const assetStore = transaction.objectStore(ASSET_STORE)
    const documentStore = transaction.objectStore(DOCUMENT_STORE)
    const added = Object.keys(pruned.assets).filter((id) => !savedAssets.has(id))
    const chunks: { page: number; ids: NodeId[] }[] = []
    pruned.pages.forEach((page, index) => {
      const ids = Object.keys(page.nodes)
      for (let i = 0; i < ids.length; i += CHUNK_NODES) chunks.push({ page: index, ids: ids.slice(i, i + CHUNK_NODES) })
    })
    const file = {
      version: KDR_VERSION,
      chunks: chunks.length,
      document: { ...pruned, assets: {}, pages: pruned.pages.map((page) => ({ ...page, nodes: {} })) },
    }
    documentStore.put(file, CURRENT)
    // 前より少なくなった分を消す
    documentStore.delete(chunkRange(chunks.length))
    // まだ書いていない画像（1 枚ずつ）と、ノードの表の分けたもの。前のものが書けてから次を写す
    // （成功の知らせは別のタスクで来るので、その間に描画や入力の処理が挟まる）
    const writes: (() => IDBRequest)[] = [
      ...added.map((id) => () => assetStore.put(pruned.assets[id], id)),
      ...chunks.map(({ page, ids }, index) => () => {
        const nodes = pruned.pages[page].nodes
        const part: Record<NodeId, SceneNode> = {}
        for (const id of ids) part[id] = nodes[id]
        const chunk: NodeChunk = { page, nodes: part }
        return documentStore.put(chunk, ['nodes', index])
      }),
    ]
    const write = (index: number) => {
      if (index < writes.length) writes[index]().onsuccess = () => write(index + 1)
    }
    write(0)
    await completed(transaction)
    for (const id of added) savedAssets.add(id)
    return true
  } catch {
    return false
  }
}
