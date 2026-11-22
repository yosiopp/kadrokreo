import { type Asset, type AssetId, type NodeId, type Scene } from '../src/document/types.ts'
import { drawPng, loadSceneImages, pngArea } from '../src/canvas/exportPng.ts'
import { layoutText } from '../src/canvas/text.ts'

// PNG の書き出し。描画は本体の canvas/render.ts をそのまま使い、ブラウザの代わりに @napi-rs/canvas（Skia）の Canvas に描く。
// @napi-rs/canvas は optionalDependencies なので、入っていない環境（ネイティブのバイナリがない、--omit=optional）では png だけが使えない。
// 描画のコードがブラウザに頼っているのは document.createElement('canvas')・createImageBitmap・DOMMatrix の 3 つなので、
// 最初の書き出しのときに、それらを Node の Canvas で置き換える（ほかのコマンドの動きは変えない）。

type NapiCanvas = typeof import('@napi-rs/canvas')

let loaded: Promise<NapiCanvas> | null = null

export class PngUnavailableError extends Error {}

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
export const FONT_FALLBACK = 'Helvetica, Arial, "Liberation Sans", "Hiragino Sans", "Hiragino Kaku Gothic ProN", "Noto Sans CJK JP", "Noto Sans JP", "Yu Gothic", Meiryo'

function addFontFallback(napi: NapiCanvas): void {
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

/**
 * targets を PNG のバイト列にする。範囲・倍率・上限・画像の待ち方は viewer / editor の renderPng と同じ（canvas/exportPng.ts を共有）。
 * targets は重なり順に並べ、親子を一緒に含めないこと。
 */
export async function encodePng(
  scene: Scene,
  assets: Record<AssetId, Asset>,
  targets: readonly NodeId[],
  scale: number,
  background: string | null = null,
): Promise<Uint8Array> {
  const napi = await canvasModule()
  // テキストの行分けは描画と同じ Canvas で測る（枠からはみ出す行を範囲に含めるため）
  const measure = napi.createCanvas(1, 1).getContext('2d') as unknown as CanvasRenderingContext2D
  const area = pngArea(scene, targets, scale, (node) => layoutText(measure, node))
  await loadSceneImages(scene, assets)
  const canvas = napi.createCanvas(area.width, area.height)
  drawPng(canvas.getContext('2d') as unknown as CanvasRenderingContext2D, scene, assets, targets, area, scale, background)
  return new Uint8Array(await canvas.encode('png'))
}
