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
// kdr の version が違う保存データ・検証に通らない保存データは読めない。黙って消さず、利用者が破棄を選ぶまで残す（その間は書かない）。
// 保存先は 1 つなので、editor を 2 つのタブで開くと上書きし合う。保存のたびに印（revision）を書き、
// 次に書くとき、保存先の印が自分の最後に読んだ・書いたものと違えば、ほかのタブが書いたものとして上書きしない。
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

/** 読めない保存データの種類。older / newer は kdr の version が今より古い・新しい、broken は検証に通らない（壊れている・形が違う） */
export type UnreadableReason = 'older' | 'newer' | 'broken'

/** 保存データを読んだ結果。none は保存データが無い（IndexedDB が使えない環境も含む） */
export type SavedDocument =
  | { kind: 'none' }
  | { kind: 'document'; document: DesignDocument }
  | { kind: 'unreadable'; reason: UnreadableReason }

/**
 * 保存の結果。blocked は、保存先にこのタブの知らないデータ（ほかのタブが書いたもの・残している読めない保存データ）が
 * あるので書かなかった
 */
export type SaveResult = 'saved' | 'failed' | 'blocked'

let database: Promise<IDBDatabase> | null = null
/** このタブが最後に読んだ・書いた保存データの印。印の無い保存データ（印を書く前の版が保存したもの）と、保存データが無いときは null */
let known: string | null = null
/** 読めない保存データを残している間は true。破棄されるまで書かない */
let retained = false
/** 保存は 1 つずつ順に行う（前の保存の印を確かめてから次を書くため） */
let saving: Promise<unknown> = Promise.resolve()

/** 保存データ（'current' のレコード）の印。無ければ null */
export function revisionOf(file: unknown): string | null {
  const revision = (file as { revision?: unknown } | null | undefined)?.revision
  return typeof revision === 'string' ? revision : null
}

/** 保存データの version を今の kdr の version と比べる。current なら読める */
export function savedVersionKind(file: unknown): 'current' | UnreadableReason {
  const version = (file as { version?: unknown } | null | undefined)?.version
  if (typeof version !== 'number' || !Number.isFinite(version)) return 'broken'
  if (version === KDR_VERSION) return 'current'
  return version < KDR_VERSION ? 'older' : 'newer'
}

/**
 * 保存先にあるレコード existing を上書きしてよいか。known はこのタブが最後に読んだ・書いた印。
 * 無ければ（消されていれば）失うものが無いので書いてよい。version の違うものと、印が違うもの（ほかのタブが書いた）は上書きしない
 */
export function canOverwrite(existing: unknown, known: string | null): boolean {
  if (existing === undefined) return true
  return savedVersionKind(existing) === 'current' && revisionOf(existing) === known
}

function createRevision(): string {
  // crypto.randomUUID は安全なコンテキストでしか使えない（http の LAN アドレスで開くと無い）
  return Array.from(crypto.getRandomValues(new Uint8Array(12)), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

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

/**
 * 自動保存したドキュメントを読む。読めない保存データ（version が違う・検証に通らない）は消さずに残し、unreadable を返す。
 * 残している間は saveDocument が書かない（discardSavedDocument で破棄するまで）
 */
export async function loadSavedDocument(): Promise<SavedDocument> {
  let db: IDBDatabase
  try {
    db = await openDatabase()
  } catch {
    // IndexedDB が使えない環境。空のドキュメントから始める（保存もできないので、保存のときに知らせる）
    return { kind: 'none' }
  }
  known = null
  retained = false
  try {
    const transaction = db.transaction([DOCUMENT_STORE, ASSET_STORE], 'readonly')
    const assetStore = transaction.objectStore(ASSET_STORE)
    const documentStore = transaction.objectStore(DOCUMENT_STORE)
    const [file, chunks, ids, assets] = await Promise.all([
      result(documentStore.get(CURRENT)),
      result(documentStore.getAll(chunkRange(0)) as IDBRequest<NodeChunk[]>),
      result(assetStore.getAllKeys()),
      result(assetStore.getAll() as IDBRequest<unknown[]>),
    ])
    if (file === undefined) return { kind: 'none' }

    known = revisionOf(file)
    const version = savedVersionKind(file)
    if (version !== 'current') {
      // 別の版の保存データは読めない（古い形を読み替える処理は持たない）。その版の editor なら読めるので残す
      retained = true
      return { kind: 'unreadable', reason: version }
    }
    // 画像の形は parseKdr が確かめる（壊れたもの・古い形のものがあれば、読み込みごと失敗する）
    const stored = Object.fromEntries(ids.map((id, i) => [String(id), assets[i]]))
    const doc = pruneAssets(parseKdr(kdrFile(joinChunks(file, chunks)), stored))

    // 削除された画像のデータはここで片付ける（編集中は Undo で戻せるよう残してある）
    const orphans = ids.filter((id) => !Object.hasOwn(doc.assets, String(id)))
    if (orphans.length > 0) {
      const cleanup = db.transaction(ASSET_STORE, 'readwrite')
      for (const id of orphans) cleanup.objectStore(ASSET_STORE).delete(id)
    }
    return { kind: 'document', document: doc }
  } catch {
    // 検証に通らない保存データ（壊れている、同じ version でも別の版が書いた形）や、読み出しの失敗。
    // 空から始めて次の保存で上書きすると黙って失うので、これも残す
    retained = true
    return { kind: 'unreadable', reason: 'broken' }
  }
}

/**
 * 残している読めない保存データを、画像ごと消す。消したら true。
 * 読んだあとでほかのタブが書き換えていたら、消さずに false を返す（読み直すこと）。消せなければ投げる
 */
export async function discardSavedDocument(): Promise<boolean> {
  const db = await openDatabase()
  const transaction = db.transaction([DOCUMENT_STORE, ASSET_STORE], 'readwrite')
  const documentStore = transaction.objectStore(DOCUMENT_STORE)
  const assetStore = transaction.objectStore(ASSET_STORE)
  let replaced = false
  const current = documentStore.get(CURRENT)
  current.onsuccess = () => {
    if (current.result !== undefined && revisionOf(current.result) !== known) {
      replaced = true
      return
    }
    documentStore.clear()
    assetStore.clear()
  }
  await completed(transaction)
  if (replaced) return false
  known = null
  retained = false
  return true
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

/**
 * ドキュメントを保存する。保存先にこのタブの知らないデータがあれば、書かずに blocked を返す（canOverwrite）。
 * 前の保存が終わってから書く
 */
export function saveDocument(doc: DesignDocument): Promise<SaveResult> {
  const next = saving.then(() => writeDocument(doc))
  saving = next
  return next
}

async function writeDocument(doc: DesignDocument): Promise<SaveResult> {
  if (retained) return 'blocked'
  let blocked = false
  try {
    const db = await openDatabase()
    const pruned = pruneAssets(doc)
    const transaction = db.transaction([DOCUMENT_STORE, ASSET_STORE], 'readwrite')
    const assetStore = transaction.objectStore(ASSET_STORE)
    const documentStore = transaction.objectStore(DOCUMENT_STORE)
    const chunks: { page: number; ids: NodeId[] }[] = []
    pruned.pages.forEach((page, index) => {
      const ids = Object.keys(page.nodes)
      for (let i = 0; i < ids.length; i += CHUNK_NODES) chunks.push({ page: index, ids: ids.slice(i, i + CHUNK_NODES) })
    })
    const revision = createRevision()
    const file = {
      version: KDR_VERSION,
      revision,
      chunks: chunks.length,
      document: { ...pruned, assets: {}, pages: pruned.pages.map((page) => ({ ...page, nodes: {} })) },
    }
    // 書く前に、同じトランザクションの中で保存先の印と、書いてある画像を確かめる。
    // 画像は一度書いたものは書き直さない（id は中身のハッシュ）。書いてあるかどうかは保存先で確かめる
    // （このタブの覚え書きだと、ほかのタブが片付けた画像を書かずに済ませてしまう）
    const current = documentStore.get(CURRENT)
    const storedIds = assetStore.getAllKeys()
    storedIds.onsuccess = () => {
      if (!canOverwrite(current.result, known)) {
        blocked = true
        transaction.abort()
        return
      }
      const stored = new Set<AssetId>(storedIds.result.map(String))
      const added = Object.keys(pruned.assets).filter((id) => !stored.has(id))
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
    }
    await completed(transaction)
    known = revision
    return 'saved'
  } catch {
    return blocked ? 'blocked' : 'failed'
  }
}
