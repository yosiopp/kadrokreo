import { KDR_VERSION, kdrFile, parseKdr } from '../document/kdr.ts'
import type { AssetId, DesignDocument } from '../document/types.ts'
import { pruneAssets } from './operations/document.ts'

// 編集中のドキュメントはブラウザの IndexedDB に自動保存する。
// 画像は大きいので別のストアに分け、一度書いたものは書き直さない（id は中身のハッシュなので、同じ id なら中身も同じ）。
// 画像は { mime, bytes }（バイト列）のまま保存する（v15 までは base64 の文字列だった）。
// ドキュメントはメモリ上の形（平らなノードの表）のまま保存し、読むときに kdr の形へ直して parseKdr で検証する。
// kdr の version が違う保存データ（古い形）は読めないので、画像ごと捨てて空のドキュメントから始める。
const DB_NAME = 'kadrokreo'
const DOCUMENT_STORE = 'document'
const ASSET_STORE = 'assets'
const CURRENT = 'current'

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
    const [file, ids, assets] = await Promise.all([
      result(transaction.objectStore(DOCUMENT_STORE).get(CURRENT)),
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
    const doc = pruneAssets(parseKdr(kdrFile(file.document), stored))

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
    const added: AssetId[] = []
    for (const [id, asset] of Object.entries(pruned.assets)) {
      if (savedAssets.has(id)) continue
      transaction.objectStore(ASSET_STORE).put(asset, id)
      added.push(id)
    }
    const file = { version: KDR_VERSION, document: { ...pruned, assets: {} } }
    transaction.objectStore(DOCUMENT_STORE).put(file, CURRENT)
    await completed(transaction)
    for (const id of added) savedAssets.add(id)
    return true
  } catch {
    return false
  }
}
