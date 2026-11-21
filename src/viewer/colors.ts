// 色の書き方（HEX / RGB / HSL）。ドキュメントの色は、いつも #rrggbb で持っている（kdr の読み込みで検証済み）。

export type ColorFormat = 'hex' | 'rgb' | 'hsl'

export const COLOR_FORMAT_LABELS: Record<ColorFormat, string> = { hex: 'HEX', rgb: 'RGB', hsl: 'HSL' }

/**
 * #rrggbb の色を、format の書き方にする。alpha（0〜1）を渡すと、透明度つきの書き方にする
 * （HEX のときは rgba。#rrggbbaa は透明度が読み取りにくいため）。HEX は、upper なら大文字（設定の一覧）、そうでなければ小文字（CSS）。
 */
export function formatColor(color: string, format: ColorFormat, options: { alpha?: number; upper?: boolean } = {}): string {
  const { alpha, upper = false } = options
  const [r, g, b] = [1, 3, 5].map((start) => parseInt(color.slice(start, start + 2), 16))
  const a = alpha === undefined ? undefined : Math.round(alpha * 100) / 100
  if (format === 'rgb' || (format === 'hex' && a !== undefined)) return a === undefined ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${a})`
  if (format === 'hsl') {
    const [h, s, l] = toHsl(r, g, b)
    return a === undefined ? `hsl(${h}, ${s}%, ${l}%)` : `hsla(${h}, ${s}%, ${l}%, ${a})`
  }
  return upper ? color.toUpperCase() : color.toLowerCase()
}

/** 色相（度）、彩度・明度（%）。どれも整数に丸める */
function toHsl(r: number, g: number, b: number): [number, number, number] {
  const [rn, gn, bn] = [r / 255, g / 255, b / 255]
  const max = Math.max(rn, gn, bn)
  const min = Math.min(rn, gn, bn)
  const l = (max + min) / 2
  const d = max - min
  if (d === 0) return [0, 0, Math.round(l * 100)]
  const s = d / (1 - Math.abs(2 * l - 1))
  let h: number
  if (max === rn) h = ((gn - bn) / d) % 6
  else if (max === gn) h = (bn - rn) / d + 2
  else h = (rn - gn) / d + 4
  return [(Math.round(h * 60) + 360) % 360, Math.round(s * 100), Math.round(l * 100)]
}

/**
 * 色の不透明度（0〜1）。ドキュメントの色はいまは #rrggbb だけなので 1 になるが、
 * 透明度つきの #rrggbbaa を受け付けるようになっても、見える色の数え方（summary.ts）が正しく働くようにしておく
 */
export function colorAlpha(color: string): number {
  return color.length === 9 ? parseInt(color.slice(7, 9), 16) / 255 : 1
}
