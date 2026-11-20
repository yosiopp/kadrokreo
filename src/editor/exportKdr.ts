import {
  KDR_EXTENSION,
  KDR_FORMAT,
  KDR_MAX_BYTES,
  KDR_VERSION,
  KdrError,
} from '../document/kdr.ts'
import type { DesignDocument } from '../document/types.ts'
import { pruneAssets } from './operations.ts'

/** kdr ファイルの中身（圧縮前の JSON）。削除済みの画像のデータは含めない */
export function serializeKdr(doc: DesignDocument): string {
  return JSON.stringify({ format: KDR_FORMAT, version: KDR_VERSION, document: pruneAssets(doc) })
}

export async function encodeKdr(doc: DesignDocument): Promise<Blob> {
  const json = new Blob([serializeKdr(doc)])
  // 読み込み側の上限を超えるファイルは、書き出せても開けない
  if (json.size > KDR_MAX_BYTES) {
    throw new KdrError('画像が多すぎて kdr に書き出せません。画像を減らすか小さくしてください。')
  }
  return new Response(json.stream().pipeThrough(new CompressionStream('gzip'))).blob()
}

export function kdrFileName(name: string): string {
  // eslint-disable-next-line no-control-regex
  const safe = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim()
  return (safe || 'Untitled') + KDR_EXTENSION
}

export async function downloadKdr(doc: DesignDocument): Promise<void> {
  const url = URL.createObjectURL(await encodeKdr(doc))
  const link = document.createElement('a')
  link.href = url
  link.download = kdrFileName(doc.name)
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}
