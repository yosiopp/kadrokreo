import type { NodeKind } from '../document/path.ts'
import type { AutoLayout, BlendMode, Cap, ComponentProperty, Constraint, Effect, ImageNode, MaskType, Override, Paint, Sizing, StrokeJoin } from '../document/types.ts'

// 設定の値の、画面での呼び名。editor のプロパティパネルと、viewer のインスペクトが同じ言葉で出す

export const TYPE_LABELS: Record<NodeKind, string> = {
  frame: 'フレーム',
  rect: '長方形',
  ellipse: '楕円',
  line: '直線',
  path: 'パス',
  text: 'テキスト',
  image: '画像',
  boolean: 'ブーリアン演算',
}

/** マスクの種類の呼び名 */
export const MASK_TYPE_LABELS: Record<MaskType, string> = { vector: '形', alpha: '不透明度', luminance: '明るさ' }

export const FIT_LABELS: Record<ImageNode['fit'], string> = {
  cover: '枠を埋めて切り抜く',
  contain: '全体を収める',
  stretch: '引き伸ばす',
}

export const PAINT_TYPE_LABELS: Record<Paint['type'], string> = {
  solid: '単色',
  linear: '直線のグラデーション',
  radial: '円形のグラデーション',
  conic: '角度のグラデーション',
}

export const EFFECT_TYPE_LABELS: Record<Effect['type'], string> = {
  'drop-shadow': '落ち影',
  'inner-shadow': '内側の影',
  'layer-blur': 'レイヤーのぼかし',
  'background-blur': '背景のぼかし',
}

/** 描画モードの呼び名（既存のデザインツールの日本語版に近い名前） */
export const BLEND_MODE_LABELS: Record<BlendMode, string> = {
  normal: '通常',
  multiply: '乗算',
  screen: 'スクリーン',
  overlay: 'オーバーレイ',
  darken: '比較（暗）',
  lighten: '比較（明）',
  'color-dodge': '覆い焼きカラー',
  'color-burn': '焼き込みカラー',
  'hard-light': 'ハードライト',
  'soft-light': 'ソフトライト',
  difference: '差の絶対値',
  exclusion: '除外',
  hue: '色相',
  saturation: '彩度',
  color: 'カラー',
  luminosity: '輝度',
}

/** 文字の太さ（100〜900）の呼び名。CSS や書体の一般的な名前 */
export const FONT_WEIGHT_LABELS: Record<string, string> = {
  '100': '100 Thin',
  '200': '200 ExtraLight',
  '300': '300 Light',
  '400': '400 Regular',
  '500': '500 Medium',
  '600': '600 SemiBold',
  '700': '700 Bold',
  '800': '800 ExtraBold',
  '900': '900 Black',
}

/** 線の角の形の呼び名 */
export const JOIN_LABELS: Record<StrokeJoin, string> = {
  miter: 'とがらせる',
  round: '丸',
  bevel: '切り落とす',
}

export const CAP_LABELS: Record<Cap, string> = {
  none: 'なし',
  round: '丸',
  square: '四角',
  arrow: '矢印',
  circle: '丸の印',
  diamond: 'ひし形の印',
}

/** パスの頂点の種類（editor のパネル）。曲線は制御点が一直線でない頂点で、選んでは切り替えない */
export const VERTEX_KIND_LABELS: Record<'corner' | 'smooth' | 'curve', string> = {
  corner: '角',
  smooth: 'なめらか',
  curve: '折れた曲線',
}

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
/** コンポーネントのプロパティの種類の呼び名 */
export const PROPERTY_TYPE_LABELS: Record<ComponentProperty['type'], string> = {
  text: '文言',
  boolean: '表示の切り替え',
  instance: 'インスタンスの差し替え',
}

export const OVERRIDE_LABELS: Record<keyof Override, string> = {
  text: '文言',
  fills: '塗り',
  strokes: '線',
  strokeDashes: '破線',
  strokeDashOffset: '破線のずれ',
  visible: '表示',
  fontSize: '文字の大きさ',
  fontFamily: '書体',
  fontWeight: '太さ',
  assetId: '画像',
  componentId: '入れ子のインスタンスの元',
}
