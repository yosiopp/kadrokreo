import type { Bounds, Size } from '../document/geometry.ts'
import type { Asset, AssetId, NodeId, Scene } from '../document/types.ts'
import { assetRegions, changedRegions, hasBlur } from './dirty.ts'
import { renderScene } from './render.ts'
import type { Viewport } from './viewport.ts'

// 描いたページの絵を取っておき、使い回す（CanvasView）。
// - ページ・画面の位置・倍率が前と同じなら（選択枠やポインタの下の印だけが変わったとき）、取っておいた絵を写すだけ。
// - 倍率が同じで位置だけが変わったら（パン）、前の絵をずらして写し、新しく見えた端だけを描く。
//   ずらす量が画面のピクセルのちょうど整数のときに限る（半端だと絵がぼやけ、描き直したときと見た目が変わる）。
// - 画面の位置と倍率が同じで図形だけが変わったら（ドラッグの 1 歩など）、前の絵を写し、変わったノードの範囲だけを描く（dirty.ts）。
// - ホイールでズームしている途中は、前の絵を拡大・縮小して見せる（ぼやける・縮めると端が空く）。止まったら全部を描き直す（CanvasView）。
// - それ以外（範囲が広すぎる、ぼかしがある、画像の読み込みが済んだ など）は全部を描き直す。

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

/** 描き方。full は全部を描いた、reused は前の絵を使い回した（端や範囲だけを描いたものも含む）、preview はズームの途中で前の絵を拡大・縮小して見せた */
export type RenderKind = 'full' | 'reused' | 'preview'

export class SceneCache {
  /** 描き終えたページの絵の写し（選択枠などを重ねる前） */
  private copy = document.createElement('canvas').getContext('2d')!
  /** copy に取ってある絵を描いたときの入力 */
  private last: SceneInput | null = null
  /** 取っておいた絵が使えなくなった（書体の読み込みが済んだ など）ときに立てる */
  private stale = true
  /** 取っておいた絵を描いた後にデコードが済んだ画像。使っているノードの範囲だけを描き直す */
  private loaded = new Set<Asset>()

  invalidate(): void {
    this.stale = true
  }

  /** 画像のデコードが済んだ。次に描くとき、その画像を使うノードを描き直す */
  invalidateAsset(asset: Asset): void {
    this.loaded.add(asset)
  }

  /**
   * target（画面のキャンバス）に input のページを描く。使い回せる分は使い回す。
   * zooming なら（ホイールでズームしている途中）、ページが同じなら前の絵を拡大・縮小して写すだけにし、取っておく絵は変えない。
   * 止まったら呼ぶ側がもう一度（zooming なしで）呼んで描き直す。
   * 図形を描くのはいつも target そのもの — DOM の外のキャンバスに描いてから写すと、Chrome の描き方が変わって文字の形が少しずれるため。
   * 取っておくのは target に描いた絵の写しで、写すだけなら画素は変わらない
   */
  render(target: CanvasRenderingContext2D, input: SceneInput, zooming = false): RenderKind {
    const { width, height } = target.canvas
    const last = this.last
    const reusable =
      !this.stale &&
      last !== null &&
      last.assets === input.assets &&
      last.size.width === input.size.width &&
      last.size.height === input.size.height &&
      last.pixelRatio === input.pixelRatio &&
      last.labelColor === input.labelColor &&
      last.hiddenId === input.hiddenId &&
      this.copy.canvas.width === width &&
      this.copy.canvas.height === height
    const sameScene = reusable && last.scene === input.scene
    const same = reusable && sameViewport(last.viewport, input.viewport)
    const shift = sameScene && !same ? panShift(last.viewport, input.viewport, input.pixelRatio, { width, height }) : null

    if (sameScene && !same && !shift && zooming) {
      // ズームの途中は前の絵を拡大・縮小して見せる。取っておく絵（last と copy）はそのまま
      const scale = input.viewport.zoom / last.viewport.zoom
      const x = (last.viewport.x - input.viewport.x) * input.viewport.zoom * input.pixelRatio
      const y = (last.viewport.y - input.viewport.y) * input.viewport.zoom * input.pixelRatio
      blit(this.copy.canvas, target, x, y, scale)
      return 'preview'
    }

    let kind: RenderKind = 'reused'
    const loaded = this.loaded
    this.loaded = new Set()
    if (sameScene && same && loaded.size > 0) {
      const regions = assetRegions(input.scene, input.assets, loaded, input.viewport, input.size, input.pixelRatio, target)
      if (regions) {
        blit(this.copy.canvas, target, 0, 0)
        for (const region of regions) draw(target, input, region)
      } else {
        draw(target, input)
        kind = 'full'
      }
    } else if (sameScene && same) {
      blit(this.copy.canvas, target, 0, 0)
    } else if (shift && loaded.size === 0 && !sceneHasBlur(input.scene)) {
      blit(this.copy.canvas, target, shift.x, shift.y)
      // 前の絵をずらして写したので、新しく見えた端だけを描く
      for (const region of exposedRegions(shift.x / input.pixelRatio, shift.y / input.pixelRatio, input.size)) draw(target, input, region)
    } else {
      // 画面の位置が同じで図形だけが変わったら（ドラッグの 1 歩など）、変わったノードの範囲だけを描く（dirty.ts）
      const regions = reusable && same && loaded.size === 0 ? changedRegions(last.scene, input.scene, input.viewport, input.size, input.pixelRatio, target) : null
      if (regions) {
        blit(this.copy.canvas, target, 0, 0)
        for (const region of regions) draw(target, input, region)
      } else {
        draw(target, input)
        kind = 'full'
      }
    }
    this.last = input
    this.stale = false
    if (kind === 'reused' && same && sameScene && loaded.size === 0) return kind
    if (this.copy.canvas.width !== width || this.copy.canvas.height !== height) {
      this.copy.canvas.width = width
      this.copy.canvas.height = height
    }
    blit(target.canvas, this.copy, 0, 0)
    return kind
  }
}

function sameViewport(a: Viewport, b: Viewport): boolean {
  return a.x === b.x && a.y === b.y && a.zoom === b.zoom
}

/** ページにぼかしがあるか。ぼかしは範囲の外の画素を混ぜて描くので、端や範囲だけを描くと縁が合わない */
function sceneHasBlur(scene: Scene): boolean {
  return hasBlur(scene, null, [])
}

/** source の絵を scale 倍して、target 全体と置き換えて (x, y) の位置に写す（はみ出さなかった所は透明になる） */
function blit(source: HTMLCanvasElement, target: CanvasRenderingContext2D, x: number, y: number, scale = 1): void {
  target.save()
  target.setTransform(1, 0, 0, 1, 0, 0)
  target.globalCompositeOperation = 'copy'
  if (scale === 1) target.drawImage(source, x, y)
  else {
    target.imageSmoothingQuality = 'low'
    target.drawImage(source, x, y, source.width * scale, source.height * scale)
  }
  target.restore()
}

function draw(ctx: CanvasRenderingContext2D, input: SceneInput, region?: Bounds): void {
  const { scene, assets, viewport, size, pixelRatio, labelColor, hiddenId } = input
  renderScene(ctx, scene, assets, viewport, size, pixelRatio, { labelColor, hiddenId, region })
}
