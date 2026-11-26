import { STAR_DEFAULT_RATIO } from '../document/polygon.ts'

/** キャンバスで使うツール */
export type Tool = 'select' | 'frame' | 'rect' | 'ellipse' | 'polygon' | 'star' | 'line' | 'pen' | 'text'

/**
 * 多角形・星のツールで描く形。描いたものはふつうのパスになるので、後から頂点の数は変えられない（ツールの設定で次に描く形を決める）。
 * ブラウザには保存しない（開き直すと既定に戻る）
 */
export type ShapeOptions = {
  /** 多角形の頂点の数 */
  polygonCount: number
  /** 星の先の数 */
  starCount: number
  /** 星の内側の頂点の、先に対する半径の比（0 より大きく 1 未満） */
  starRatio: number
}

export const DEFAULT_SHAPE_OPTIONS: ShapeOptions = { polygonCount: 3, starCount: 5, starRatio: STAR_DEFAULT_RATIO }
