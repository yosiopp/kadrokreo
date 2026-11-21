import { KDR_EXTENSION, KDR_MAX_BYTES, KdrError, kdrFile } from '../document/kdr.ts'
import type { DesignDocument } from '../document/types.ts'
import { downloadBlob, safeFileName } from '../ui/download.ts'
import { pruneAssets } from './operations.ts'

/** kdr ファイルの中身（圧縮前の JSON）。削除済みの画像のデータは含めない */
function serializeKdr(doc: DesignDocument): string {
  return JSON.stringify(kdrFile(pruneAssets(doc)))
}

export async function encodeKdr(doc: DesignDocument): Promise<Blob> {
  const json = new Blob([serializeKdr(doc)])
  // 読み込み側の上限を超えるファイルは、書き出せても開けない
  if (json.size > KDR_MAX_BYTES) {
    throw new KdrError('画像が多すぎて kdr に書き出せません。画像を減らすか小さくしてください。')
  }
  return new Response(json.stream().pipeThrough(new CompressionStream('gzip'))).blob()
}

function kdrFileName(name: string): string {
  return safeFileName(name) + KDR_EXTENSION
}

export async function downloadKdr(doc: DesignDocument): Promise<void> {
  downloadBlob(await encodeKdr(doc), kdrFileName(doc.name))
}
