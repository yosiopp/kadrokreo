import { KDR_EXTENSION, KDR_FORMAT, KDR_VERSION } from '../document/kdr.ts'
import type { DesignDocument } from '../document/types.ts'

/** kdr ファイルの中身（圧縮前の JSON） */
export function serializeKdr(doc: DesignDocument): string {
  return JSON.stringify({ format: KDR_FORMAT, version: KDR_VERSION, document: doc })
}

export async function encodeKdr(doc: DesignDocument): Promise<Blob> {
  const gzipped = new Blob([serializeKdr(doc)]).stream().pipeThrough(new CompressionStream('gzip'))
  return new Response(gzipped).blob()
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
