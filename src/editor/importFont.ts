import { cleanFamilyName, readFontFileInfo } from '../document/fontFile.ts'
import { KDR_MAX_ASSET_BYTES } from '../document/kdr.ts'
import type { Asset, EmbeddedFont } from '../document/types.ts'

/** 取り込める書体ファイルの種類（ファイルを選ぶ画面に出すもの） */
export const FONT_ACCEPT = '.ttf,.otf,.woff,.woff2,font/ttf,font/otf,font/woff,font/woff2'

export type ImportedFont = { asset: Asset; face: Omit<EmbeddedFont, 'assetId'> }

/**
 * 書体ファイルを読み、kdr に埋め込む書体にする。書体名・太さ・斜体はファイルの name / OS/2 の表から読む
 * （書体名がなければファイル名）。ブラウザで書体として読めないファイルは取り込まない
 */
export async function readFontFile(file: File): Promise<ImportedFont> {
  if (file.size > KDR_MAX_ASSET_BYTES) {
    throw new Error(`${file.name}: 書体ファイルが大きすぎます（${KDR_MAX_ASSET_BYTES / 1024 / 1024}MB まで）`)
  }
  const bytes = new Uint8Array(await file.arrayBuffer())
  const info = await readFontFileInfo(bytes)
  if (info === null) {
    throw new Error(`${file.name}: TTF / OTF / WOFF / WOFF2 の書体ファイルとして読めません`)
  }
  const family = info.family ?? cleanFamilyName(file.name.replace(/\.[^.]+$/, '')) ?? 'Font'
  const face = { family, weight: info.weight, style: info.style }
  try {
    await new FontFace(family, bytes.slice().buffer, { weight: String(face.weight), style: face.style }).load()
  } catch {
    throw new Error(`${file.name}: この書体ファイルはブラウザで読めません`)
  }
  return { asset: { mime: info.mime, bytes }, face }
}
