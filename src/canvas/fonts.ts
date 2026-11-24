import type { Asset, AssetId, EmbeddedFont } from '../document/types.ts'
import { forgetTextLayout } from './text.ts'

// ドキュメントに埋め込んだ書体（document.fonts）を、ブラウザの書体（document.fonts の FontFaceSet）に登録する。
// 登録した書体は、OS やブラウザの同じ名前の書体より先に使われる（Canvas の font の書体名が family と同じなら）。
// 書体のファイルはバイト列から作るので、ほとんどはその場で使えるようになる。読み込みが済んだら、測った行分けを捨てて描き直してもらう。

type Registered = { face: FontFace; loaded: Promise<void> }

/** 登録している書体。キーは書体のファイルと書体名・太さ・斜体 */
const registered = new Map<string, Registered>()
const listeners = new Set<() => void>()

function keyOf(font: EmbeddedFont): string {
  return `${font.assetId}\u0000${font.family}\u0000${font.weight}\u0000${font.style}`
}

function fontSet(): FontFaceSet | null {
  return typeof document === 'undefined' || typeof FontFace === 'undefined' ? null : (document.fonts ?? null)
}

/**
 * 埋め込んだ書体を登録し、もうドキュメントにない書体の登録を外す（同じ並びで何度呼んでもよい）。
 * 書体のファイルが壊れていれば登録しない（その書体名のテキストは OS の書体で描かれる）
 */
export function syncEmbeddedFonts(fonts: readonly EmbeddedFont[], assets: Record<AssetId, Asset>): void {
  const set = fontSet()
  if (set === null) return
  const wanted = new Map(fonts.filter((font) => Object.hasOwn(assets, font.assetId)).map((font) => [keyOf(font), font]))
  // 外した書体で描いてあった絵も描き直してもらう
  let changed = false
  for (const [key, { face }] of registered) {
    if (wanted.has(key)) continue
    set.delete(face)
    registered.delete(key)
    changed = true
  }
  for (const [key, font] of wanted) {
    if (registered.has(key)) continue
    const bytes = assets[font.assetId].bytes
    const face = new FontFace(font.family, bytes.slice().buffer, { weight: String(font.weight), style: font.style })
    set.add(face)
    const loaded = face.loaded.then(
      () => {},
      () => {
        // 書体として読めないファイル。登録を外し、OS の書体で描かれるままにする
        set.delete(face)
      },
    )
    registered.set(key, { face, loaded })
    changed = true
    // その場で読めなかった書体は、読めたら描き直してもらう
    if (face.status !== 'loaded') loaded.then(notify)
  }
  if (changed) notify()
}

function notify(): void {
  forgetTextLayout()
  for (const listener of listeners) listener()
}

/** 埋め込んだ書体が使えるようになった・外れたら呼ばれる。描き直しに使う */
export function onEmbeddedFontsChange(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** 登録した書体の読み込みが全部済むまで待つ（PNG の書き出しの前に。済んでいないと OS の書体で描かれてしまう） */
export async function embeddedFontsReady(): Promise<void> {
  await Promise.all([...registered.values()].map((entry) => entry.loaded))
}
