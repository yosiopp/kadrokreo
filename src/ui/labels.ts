import type { NodeKind } from '../document/path.ts'
import type { AutoLayout, Cap, Constraint, ImageNode, Override, Sizing } from '../document/types.ts'

// 設定の値の、画面での呼び名。editor のプロパティパネルと、viewer のインスペクトが同じ言葉で出す

export const TYPE_LABELS: Record<NodeKind, string> = {
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

export const SIZING_LABELS: Record<Sizing, string> = {
  hug: '中身に合わせる',
  fixed: '固定',
  fill: '親いっぱい',
}

/** 折り返したときの行のまとまりの置き方 */
export const ALIGN_CONTENT_LABELS: Record<AutoLayout['alignContent'], string> = {
  auto: '揃えに従う',
  'space-between': '均等に配る',
}

/** 親の大きさが変わったときの追従のしかた。横と縦で呼び名が違う */
export const CONSTRAINT_LABELS: Record<'horizontal' | 'vertical', Record<Constraint, string>> = {
  horizontal: { start: '左', end: '右', stretch: '左右', center: '中央', scale: '拡大縮小' },
  vertical: { start: '上', end: '下', stretch: '上下', center: '中央', scale: '拡大縮小' },
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
  fills: '塗り',
  strokes: '線',
  visible: '表示',
  fontSize: '文字の大きさ',
  fontFamily: '書体',
  fontWeight: '太さ',
  assetId: '画像',
  componentId: '入れ子のインスタンスの元',
}
