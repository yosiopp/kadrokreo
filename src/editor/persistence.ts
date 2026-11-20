import { KDR_FORMAT, KDR_VERSION, parseKdr } from '../document/kdr.ts'
import type { Asset, AssetId, DesignDocument } from '../document/types.ts'
import { pruneAssets } from './operations.ts'

// 編集中のドキュメントはブラウザの IndexedDB に自動保存する。
// 画像は大きいので別のストアに分け、一度書いたものは書き直さない。
const DB_NAME = 'kadrokreo'
const DOCUMENT_STORE = 'document'
const ASSET_STORE = 'assets'
const CURRENT = 'current'
/** IndexedDB に移る前の保存先。残っていれば一度だけ読む */
const LEGACY_STORAGE_KEY = 'kadrokreo:document'

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
      result(assetStore.getAll() as IDBRequest<Asset[]>),
    ])
    if (file === undefined) return loadLegacyDocument()

    const stored = Object.fromEntries(ids.map((id, i) => [String(id), assets[i]]))
    const doc = pruneAssets(parseKdr({ ...file, document: { ...file.document, assets: stored } }))

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

function loadLegacyDocument(): DesignDocument | null {
  const raw = localStorage.getItem(LEGACY_STORAGE_KEY)
  return raw === null ? null : parseKdr(JSON.parse(raw))
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
    const file = { format: KDR_FORMAT, version: KDR_VERSION, document: { ...pruned, assets: {} } }
    transaction.objectStore(DOCUMENT_STORE).put(file, CURRENT)
    await completed(transaction)
    for (const id of added) savedAssets.add(id)
    return true
  } catch {
    return false
  }
}
