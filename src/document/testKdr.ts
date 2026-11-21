// テスト用: kdr（tar.gz）のバイト列を組み立てる。細工したファイルを作れるよう、名前や中身を自由に並べられる。
import { tarParts, type TarEntry } from './tar.ts'
import type { Asset } from './types.ts'

const EXTENSIONS: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }

export async function gzipBlob(data: BlobPart | BlobPart[]): Promise<Blob> {
  const parts = Array.isArray(data) ? data : [data]
  return new Response(new Blob(parts).stream().pipeThrough(new CompressionStream('gzip'))).blob()
}

/** 名前と中身の並びを tar にして gzip する（中身が文字列なら UTF-8） */
export function tarGz(entries: readonly { name: string; bytes: Uint8Array<ArrayBuffer> | string }[]): Promise<Blob> {
  const encoded: TarEntry[] = entries.map((entry) => ({
    name: entry.name,
    bytes: typeof entry.bytes === 'string' ? new TextEncoder().encode(entry.bytes) : entry.bytes,
  }))
  return gzipBlob(tarParts(encoded))
}

/** document.json（値なら JSON にする。文字列ならそのまま）と画像から kdr を作る */
export function kdrBlob(document: unknown, assets: Record<string, Asset> = {}): Promise<Blob> {
  return tarGz([
    { name: 'document.json', bytes: typeof document === 'string' ? document : JSON.stringify(document) },
    ...Object.entries(assets).map(([id, asset]) => ({ name: `assets/${id}.${EXTENSIONS[asset.mime] ?? 'png'}`, bytes: asset.bytes })),
  ])
}

/** base64 の文字列からバイト列 */
export function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}
