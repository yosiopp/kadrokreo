import {
  KDR_DOCUMENT_NAME,
  KDR_EXTENSION,
  KDR_MAX_ASSET_BYTES,
  KDR_MAX_ASSETS,
  KDR_MAX_BYTES,
  KDR_MAX_JSON_BYTES,
  KdrError,
  assetFileName,
  kdrFile,
} from '../document/kdr.ts'
import { tarParts, type TarEntry } from '../document/tar.ts'
import type { DesignDocument } from '../document/types.ts'
import { downloadBlob, safeFileName } from '../ui/download.ts'
import { pruneAssets } from './operations/document.ts'

/**
 * kdr ファイルの中身（tar にまとめる前のファイルの並び）。document.json のあとに画像を id の順に入れる。
 * 削除済みの画像のデータは含めない
 */
export function kdrEntries(doc: DesignDocument): TarEntry[] {
  const pruned = pruneAssets(doc)
  const json = new TextEncoder().encode(JSON.stringify(kdrFile(pruned)))
  const entries: TarEntry[] = [{ name: KDR_DOCUMENT_NAME, bytes: json }]
  for (const id of Object.keys(pruned.assets).sort()) {
    const asset = pruned.assets[id]
    entries.push({ name: assetFileName(id, asset), bytes: asset.bytes })
  }
  return entries
}

export async function encodeKdr(doc: DesignDocument): Promise<Blob> {
  const entries = kdrEntries(doc)
  // 読み込み側の上限を超えるファイルは、書き出せても開けない
  const tar = new Blob(tarParts(entries))
  if (entries[0].bytes.length > KDR_MAX_JSON_BYTES) {
    throw new KdrError('ドキュメントが大きすぎて kdr に書き出せません。')
  }
  if (entries.length - 1 > KDR_MAX_ASSETS || entries.slice(1).some((entry) => entry.bytes.length > KDR_MAX_ASSET_BYTES) || tar.size > KDR_MAX_BYTES) {
    throw new KdrError('画像が多すぎるか大きすぎて kdr に書き出せません。画像を減らすか小さくしてください。')
  }
  return new Response(tar.stream().pipeThrough(new CompressionStream('gzip'))).blob()
}

function kdrFileName(name: string): string {
  return safeFileName(name) + KDR_EXTENSION
}

export async function downloadKdr(doc: DesignDocument): Promise<void> {
  downloadBlob(await encodeKdr(doc), kdrFileName(doc.name))
}
