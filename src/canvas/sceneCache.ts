import type { Bounds, Size } from '../document/geometry.ts'
import type { Asset, AssetId, NodeId, Scene } from '../document/types.ts'
import { renderScene } from './render.ts'
import type { Viewport } from './viewport.ts'

// 描いたページの絵を取っておき、使い回す（CanvasView）。
// - ページ・画面の位置・倍率が前と同じなら（選択枠やポインタの下の印だけが変わったとき）、取っておいた絵を写すだけ。
// - 倍率が同じで位置だけが変わったら（パン）、前の絵をずらして写し、新しく見えた端だけを描く。
//   ずらす量が画面のピクセルのちょうど整数のときに限る（半端だと絵がぼやけ、描き直したときと見た目が変わる）。
// - それ以外（図形を動かした、ズームした、画像の読み込みが済んだ など）は全部を描き直す。

export type SceneInput = {
  scene: Scene
  assets: Record<AssetId, Asset>
  viewport: Viewport
  /** 画面の大きさ（CSS ピクセル） */
  size: Size
  pixelRatio: number
  labelColor: string
  hiddenId: NodeId | null | undefined
}

/** ずらす量がこれより整数に近ければ、整数とみなす（画面のピクセル） */
const EPSILON = 1e-3

/**
 * 前の絵を (dx, dy) だけずらしたときに、新しく見える部分（画面座標、CSS ピクセル）。
 * 端の縦の帯と横の帯で、重ならないように分ける
 */
export function exposedRegions(dx: number, dy: number, size: Size): Bounds[] {
  const regions: Bounds[] = []
  if (dx > 0) regions.push({ x: 0, y: 0, width: dx, height: size.height })
  if (dx < 0) regions.push({ x: size.width + dx, y: 0, width: -dx, height: size.height })
  const x = Math.max(0, dx)
  const width = size.width - Math.abs(dx)
  if (dy > 0) regions.push({ x, y: 0, width, height: dy })
  if (dy < 0) regions.push({ x, y: size.height + dy, width, height: -dy })
  return regions
}

/**
 * 前の位置から今の位置へ、絵を何ピクセル（画面の実ピクセル）ずらせばよいか。ずらして使い回せなければ null
 */
export function panShift(from: Viewport, to: Viewport, pixelRatio: number, canvas: Size): { x: number; y: number } | null {
  if (from.zoom !== to.zoom) return null
  const x = (from.x - to.x) * to.zoom * pixelRatio
  const y = (from.y - to.y) * to.zoom * pixelRatio
  const rx = Math.round(x)
  const ry = Math.round(y)
  if (Math.abs(x - rx) > EPSILON || Math.abs(y - ry) > EPSILON) return null
  // 前の絵がまったく残らないなら、全部を描くのと同じ
  if (Math.abs(rx) >= canvas.width || Math.abs(ry) >= canvas.height) return null
  return { x: rx, y: ry }
}

export class SceneCache {
  /** 描き終えたページの絵の写し（選択枠などを重ねる前） */
  private copy = document.createElement('canvas').getContext('2d')!
  private last: SceneInput | null = null
  /** 取っておいた絵が使えなくなった（画像や書体の読み込みが済んだ）ときに立てる */
  private stale = true

  invalidate(): void {
    this.stale = true
  }

  /**
   * target（画面のキャンバス）に input のページを描く。使い回せる分は使い回す。
   * 図形を描くのはいつも target そのもの — DOM の外のキャンバスに描いてから写すと、Chrome の描き方が変わって文字の形が少しずれるため
   * （pitfalls.md）。取っておくのは target に描いた絵の写しで、写すだけなら画素は変わらない
   */
  render(target: CanvasRenderingContext2D, input: SceneInput): void {
    const { width, height } = target.canvas
    const last = this.last
    const reusable =
      !this.stale &&
      last !== null &&
      last.scene === input.scene &&
      last.assets === input.assets &&
      last.size.width === input.size.width &&
      last.size.height === input.size.height &&
      last.pixelRatio === input.pixelRatio &&
      last.labelColor === input.labelColor &&
      last.hiddenId === input.hiddenId &&
      this.copy.canvas.width === width &&
      this.copy.canvas.height === height
    this.last = input
    this.stale = false

    const same = reusable && last.viewport.x === input.viewport.x && last.viewport.y === input.viewport.y && last.viewport.zoom === input.viewport.zoom
    const shift = reusable && !same ? panShift(last.viewport, input.viewport, input.pixelRatio, { width, height }) : null
    if (same || shift) {
      blit(this.copy.canvas, target, shift?.x ?? 0, shift?.y ?? 0)
      if (!shift) return
      // 前の絵をずらして写したので、新しく見えた端だけを描く
      for (const region of exposedRegions(shift.x / input.pixelRatio, shift.y / input.pixelRatio, input.size)) draw(target, input, region)
    } else {
      draw(target, input)
    }
    if (this.copy.canvas.width !== width || this.copy.canvas.height !== height) {
      this.copy.canvas.width = width
      this.copy.canvas.height = height
    }
    blit(target.canvas, this.copy, 0, 0)
  }
}

/** source の絵を、target 全体と置き換えて (x, y) の位置に写す（はみ出さなかった所は透明になる） */
function blit(source: HTMLCanvasElement, target: CanvasRenderingContext2D, x: number, y: number): void {
  target.save()
  target.setTransform(1, 0, 0, 1, 0, 0)
  target.globalCompositeOperation = 'copy'
  target.drawImage(source, x, y)
  target.restore()
}

function draw(ctx: CanvasRenderingContext2D, input: SceneInput, region?: Bounds): void {
  const { scene, assets, viewport, size, pixelRatio, labelColor, hiddenId } = input
  renderScene(ctx, scene, assets, viewport, size, pixelRatio, { labelColor, hiddenId, region })
}
