import type { AutoLayout, Cap, ImageNode, Override, SceneNode } from '../document/types.ts'

// 設定の値の、画面での呼び名。editor のプロパティパネルと、viewer のインスペクトが同じ言葉で出す

export const TYPE_LABELS: Record<SceneNode['type'], string> = {
  frame: 'フレーム',
  rect: '長方形',
  ellipse: '楕円',
  line: '直線',
  path: 'パス',
  text: 'テキスト',
  image: '画像',
}

export const FIT_LABELS: Record<ImageNode['fit'], string> = {
  cover: '枠を埋めて切り抜く',
  contain: '全体を収める',
  stretch: '引き伸ばす',
}

export const CAP_LABELS: Record<Cap, string> = { none: 'なし', arrow: '矢印' }

export const SIZE_MODE_LABELS: Record<AutoLayout['widthMode'], string> = {
  hug: '中身に合わせる',
  fixed: '固定',
}

/** 並べる向きと直交する向きの揃え方。縦に並べるなら左右、横に並べるなら上下になる */
export function alignLabels(direction: AutoLayout['direction']): Record<AutoLayout['align'], string> {
  const vertical = direction === 'vertical'
  return { start: vertical ? '左' : '上', center: '中央', end: vertical ? '右' : '下' }
}

/** 呼び名の表を、選択欄に出す [値, 呼び名] の並びにする */
export function optionsOf<T extends string>(labels: Record<T, string>): [T, string][] {
  return Object.entries(labels) as [T, string][]
}

/** インスタンスごとに上書きできる項目の名前 */
export const OVERRIDE_LABELS: Record<keyof Override, string> = {
  text: '文言',
  fill: '塗り',
  fillGradient: 'グラデーション',
  stroke: '線の色',
  visible: '表示',
  fontSize: '文字の大きさ',
  fontFamily: '書体',
  fontWeight: '太さ',
  assetId: '画像',
}
