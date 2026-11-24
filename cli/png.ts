import { type Asset, type AssetId, type EmbeddedFont, type NodeId, type Scene } from '../src/document/types.ts'
import { drawPng, loadSceneImages, pngArea } from '../src/canvas/exportPng.ts'
import { fontMetrics, layoutText } from '../src/canvas/text.ts'
import type { SvgTextMetrics } from '../src/document/svgExport.ts'
import { decodeWoff2 } from '../src/document/woff2.ts'

// PNG の書き出し。描画は本体の canvas/render.ts をそのまま使い、ブラウザの代わりに @napi-rs/canvas（Skia）の Canvas に描く。
// @napi-rs/canvas は optionalDependencies なので、入っていない環境（ネイティブのバイナリがない、--omit=optional）では png だけが使えない。
// 描画のコードがブラウザに頼っているのは document.createElement('canvas')・createImageBitmap・DOMMatrix の 3 つなので、
// 最初の書き出しのときに、それらを Node の Canvas で置き換える（ほかのコマンドの動きは変えない）。

type NapiCanvas = typeof import('@napi-rs/canvas')

let loaded: Promise<NapiCanvas> | null = null

class PngUnavailableError extends Error {}

/** @napi-rs/canvas を読み込み、描画のコードが使うブラウザの部品を用意する */
function canvasModule(): Promise<NapiCanvas> {
  loaded ??= import('@napi-rs/canvas').then(
    (napi) => {
      installBrowserShims(napi)
      return napi
    },
    (error: unknown) => {
      loaded = null
      throw new PngUnavailableError(
        'PNG の書き出しには @napi-rs/canvas が要ります（optionalDependencies）。npm install で入れ直してください' +
          (error instanceof Error ? `（${error.message.split('\n')[0]}）` : ''),
      )
    },
  )
  return loaded
}

/**
 * フォントの上下の高さを、PNG の描画と同じ Canvas（書体の補い方も同じ）で測る関数。SVG の書き出しの基線と、取り込みの枠の上端に使う
 * （ブラウザの書き出し・取り込みと同じ測り方）。@napi-rs/canvas が入っていなければ undefined（呼ぶ側は見積もりに戻す）。
 * ブラウザの部品の置き換え（installBrowserShims）はしない
 */
export async function canvasTextMetrics(): Promise<SvgTextMetrics | undefined> {
  let napi: NapiCanvas
  try {
    napi = await import('@napi-rs/canvas')
  } catch {
    return undefined
  }
  addFontFallback(napi)
  const ctx = napi.createCanvas(1, 1).getContext('2d') as unknown as CanvasRenderingContext2D
  return (node) => fontMetrics(ctx, node)
}

function installBrowserShims(napi: NapiCanvas): void {
  const g = globalThis as Record<string, unknown>
  // render.ts が合成用・パターン用のキャンバスを作るのに使う。大きさは呼ぶ側が後から決める
  g.document ??= { createElement: () => napi.createCanvas(1, 1) }
  g.DOMMatrix ??= napi.DOMMatrix
  // images.ts が画像をデコードするのに使う。Skia の Image は drawImage にそのまま渡せ、width / height も持つ
  g.createImageBitmap ??= async (blob: Blob) => napi.loadImage(Buffer.from(await blob.arrayBuffer()))
  addFontFallback(napi)
}

/**
 * ブラウザは、書体にない字（日本語など）を OS の書体で補って描く。Skia は font に並べた書体しか見ないので、
 * 後ろに書体を足しておく。Skia は字ごとに前から順に探し、ない書体は飛ばす。英数字は sans-serif が見つからない環境（Docker の Alpine）向けに
 * Helvetica と同じ字幅の書体（Arial・Liberation Sans）、日本語は macOS のヒラギノ、Linux の Noto Sans CJK、Windows の游ゴシック・メイリオ。
 * 描画のコード（canvas/text.ts の applyFont）は `太さ 大きさpx 書体` を代入するので、その書き方を前提にしている。
 */
const FONT_FALLBACK = 'Helvetica, Arial, "Liberation Sans", "Hiragino Sans", "Hiragino Kaku Gothic ProN", "Noto Sans CJK JP", "Noto Sans JP", "Yu Gothic", Meiryo'

let fallbackAdded = false

function addFontFallback(napi: NapiCanvas): void {
  if (fallbackAdded) return
  fallbackAdded = true
  const proto = Object.getPrototypeOf(napi.createCanvas(1, 1).getContext('2d')) as object
  const descriptor = Object.getOwnPropertyDescriptor(proto, 'font')
  if (!descriptor?.set || !descriptor.get) return
  const { get, set } = descriptor
  Object.defineProperty(proto, 'font', {
    ...descriptor,
    get,
    set(this: unknown, value: string) {
      set.call(this, `${value}, ${FONT_FALLBACK}`)
    },
  })
}

/** 登録した埋め込みの書体（書体のファイルと書体名）。同じ実行の中では、一度登録すれば次の書き出しでも使える */
const registeredFonts = new Set<string>()

/**
 * kdr に埋め込んだ書体を Skia に登録する（ブラウザの FontFace に当たる）。書体名は family にし、太さと斜体は書体ファイルのもの
 * （kdr の weight・style もファイルから読んだ値なので揃う）。登録できない（壊れた）書体は飛ばし、OS の書体で描く
 */
function registerEmbeddedFonts(napi: NapiCanvas, fonts: readonly EmbeddedFont[], assets: Record<AssetId, Asset>): void {
  for (const font of fonts) {
    const key = `${font.assetId}\u0000${font.family}`
    if (registeredFonts.has(key) || !Object.hasOwn(assets, font.assetId)) continue
    registeredFonts.add(key)
    const asset = assets[font.assetId]
    // WOFF2 は sfnt に戻してから登録する（字の形を読む openType.ts と同じ中身にし、Skia の WOFF2 の対応に頼らない）
    const bytes = asset.mime === 'font/woff2' ? (decodeWoff2(asset.bytes) ?? asset.bytes) : asset.bytes
    napi.GlobalFonts.register(Buffer.from(bytes), font.family)
  }
}

/**
 * targets を PNG のバイト列にする。範囲・倍率・上限・画像の待ち方は viewer / editor の renderPng と同じ（canvas/exportPng.ts を共有）。
 * targets は重なり順に並べ、親子を一緒に含めないこと。fonts はドキュメントに埋め込んだ書体（描く前に登録する）
 */
export async function encodePng(
  scene: Scene,
  assets: Record<AssetId, Asset>,
  targets: readonly NodeId[],
  scale: number,
  background: string | null = null,
  fonts: readonly EmbeddedFont[] = [],
): Promise<Uint8Array> {
  const napi = await canvasModule()
  registerEmbeddedFonts(napi, fonts, assets)
  // テキストの行分けは描画と同じ Canvas で測る（枠からはみ出す行を範囲に含めるため）
  const measure = napi.createCanvas(1, 1).getContext('2d') as unknown as CanvasRenderingContext2D
  const area = pngArea(scene, targets, scale, (node) => layoutText(measure, node))
  await loadSceneImages(scene, assets)
  const canvas = napi.createCanvas(area.width, area.height)
  drawPng(canvas.getContext('2d') as unknown as CanvasRenderingContext2D, scene, assets, targets, area, scale, background)
  return new Uint8Array(await canvas.encode('png'))
}
