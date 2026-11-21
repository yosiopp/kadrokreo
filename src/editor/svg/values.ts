import { IDENTITY, type Matrix, multiply } from '../../document/geometry.ts'

// SVG の属性の値（色・長さ・transform・style 属性）を読む。読めない値は null を返し、呼び出し側が既定値を使う

// ── 色 ──

/** 色と不透明度。color は #rrggbb */
export type Rgba = { color: string; alpha: number }

const NAMED =
  'aliceblue:f0f8ff,antiquewhite:faebd7,aqua:00ffff,aquamarine:7fffd4,azure:f0ffff,beige:f5f5dc,bisque:ffe4c4,black:000000,' +
  'blanchedalmond:ffebcd,blue:0000ff,blueviolet:8a2be2,brown:a52a2a,burlywood:deb887,cadetblue:5f9ea0,chartreuse:7fff00,' +
  'chocolate:d2691e,coral:ff7f50,cornflowerblue:6495ed,cornsilk:fff8dc,crimson:dc143c,cyan:00ffff,darkblue:00008b,' +
  'darkcyan:008b8b,darkgoldenrod:b8860b,darkgray:a9a9a9,darkgreen:006400,darkgrey:a9a9a9,darkkhaki:bdb76b,darkmagenta:8b008b,' +
  'darkolivegreen:556b2f,darkorange:ff8c00,darkorchid:9932cc,darkred:8b0000,darksalmon:e9967a,darkseagreen:8fbc8f,' +
  'darkslateblue:483d8b,darkslategray:2f4f4f,darkslategrey:2f4f4f,darkturquoise:00ced1,darkviolet:9400d3,deeppink:ff1493,' +
  'deepskyblue:00bfff,dimgray:696969,dimgrey:696969,dodgerblue:1e90ff,firebrick:b22222,floralwhite:fffaf0,forestgreen:228b22,' +
  'fuchsia:ff00ff,gainsboro:dcdcdc,ghostwhite:f8f8ff,gold:ffd700,goldenrod:daa520,gray:808080,green:008000,greenyellow:adff2f,' +
  'grey:808080,honeydew:f0fff0,hotpink:ff69b4,indianred:cd5c5c,indigo:4b0082,ivory:fffff0,khaki:f0e68c,lavender:e6e6fa,' +
  'lavenderblush:fff0f5,lawngreen:7cfc00,lemonchiffon:fffacd,lightblue:add8e6,lightcoral:f08080,lightcyan:e0ffff,' +
  'lightgoldenrodyellow:fafad2,lightgray:d3d3d3,lightgreen:90ee90,lightgrey:d3d3d3,lightpink:ffb6c1,lightsalmon:ffa07a,' +
  'lightseagreen:20b2aa,lightskyblue:87cefa,lightslategray:778899,lightslategrey:778899,lightsteelblue:b0c4de,' +
  'lightyellow:ffffe0,lime:00ff00,limegreen:32cd32,linen:faf0e6,magenta:ff00ff,maroon:800000,mediumaquamarine:66cdaa,' +
  'mediumblue:0000cd,mediumorchid:ba55d3,mediumpurple:9370db,mediumseagreen:3cb371,mediumslateblue:7b68ee,' +
  'mediumspringgreen:00fa9a,mediumturquoise:48d1cc,mediumvioletred:c71585,midnightblue:191970,mintcream:f5fffa,' +
  'mistyrose:ffe4e1,moccasin:ffe4b5,navajowhite:ffdead,navy:000080,oldlace:fdf5e6,olive:808000,olivedrab:6b8e23,' +
  'orange:ffa500,orangered:ff4500,orchid:da70d6,palegoldenrod:eee8aa,palegreen:98fb98,paleturquoise:afeeee,' +
  'palevioletred:db7093,papayawhip:ffefd5,peachpuff:ffdab9,peru:cd853f,pink:ffc0cb,plum:dda0dd,powderblue:b0e0e6,' +
  'purple:800080,rebeccapurple:663399,red:ff0000,rosybrown:bc8f8f,royalblue:4169e1,saddlebrown:8b4513,salmon:fa8072,' +
  'sandybrown:f4a460,seagreen:2e8b57,seashell:fff5ee,sienna:a0522d,silver:c0c0c0,skyblue:87ceeb,slateblue:6a5acd,' +
  'slategray:708090,slategrey:708090,snow:fffafa,springgreen:00ff7f,steelblue:4682b4,tan:d2b48c,teal:008080,thistle:d8bfd8,' +
  'tomato:ff6347,turquoise:40e0d0,violet:ee82ee,wheat:f5deb3,white:ffffff,whitesmoke:f5f5f5,yellow:ffff00,yellowgreen:9acd32'

const NAMED_COLORS = new Map(NAMED.split(',').map((entry) => entry.split(':') as [string, string]))

const hex2 = (value: number) => Math.round(Math.min(255, Math.max(0, value))).toString(16).padStart(2, '0')

/** CSS の色（#rgb・#rrggbb・#rgba・#rrggbbaa・rgb()・rgba()・hsl()・hsla()・色の名前・transparent）。currentColor は呼び出し側で扱う */
export function parseColor(raw: string): Rgba | null {
  const value = raw.trim().toLowerCase()
  if (value === 'transparent') return { color: '#000000', alpha: 0 }
  const named = NAMED_COLORS.get(value)
  if (named) return { color: `#${named}`, alpha: 1 }
  const hex = /^#([0-9a-f]{3,8})$/.exec(value)
  if (hex) {
    const digits = hex[1]
    if (digits.length === 3 || digits.length === 4) {
      const [r, g, b, a] = [...digits].map((digit) => digit + digit)
      return { color: `#${r}${g}${b}`, alpha: a === undefined ? 1 : parseInt(a, 16) / 255 }
    }
    if (digits.length === 6 || digits.length === 8) {
      return { color: `#${digits.slice(0, 6)}`, alpha: digits.length === 8 ? parseInt(digits.slice(6), 16) / 255 : 1 }
    }
    return null
  }
  const fn = /^(rgba?|hsla?)\(([^)]*)\)$/.exec(value)
  if (!fn) return null
  const parts = fn[2].split(/[\s,/]+/).filter((part) => part !== '')
  if (parts.length !== 3 && parts.length !== 4) return null
  const number = (part: string, percentOf: number) => {
    const n = parseFloat(part)
    if (!Number.isFinite(n)) return NaN
    return part.endsWith('%') ? (n / 100) * percentOf : n
  }
  const alpha = parts.length === 4 ? number(parts[3], 1) : 1
  if (!Number.isFinite(alpha)) return null
  if (fn[1].startsWith('rgb')) {
    const [r, g, b] = parts.slice(0, 3).map((part) => number(part, 255))
    if (![r, g, b].every(Number.isFinite)) return null
    return { color: `#${hex2(r)}${hex2(g)}${hex2(b)}`, alpha: clamp01(alpha) }
  }
  const h = parseFloat(parts[0])
  const s = number(parts[1], 1)
  const l = number(parts[2], 1)
  if (![h, s, l].every(Number.isFinite)) return null
  const [r, g, b] = hslToRgb(((h % 360) + 360) % 360, clamp01(s), clamp01(l))
  return { color: `#${hex2(r)}${hex2(g)}${hex2(b)}`, alpha: clamp01(alpha) }
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const k = (n: number) => (n + h / 30) % 12
  const a = s * Math.min(l, 1 - l)
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))
  return [f(0) * 255, f(8) * 255, f(4) * 255]
}

export function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}

// ── 長さと数 ──

const UNITS: Record<string, number> = { '': 1, px: 1, pt: 4 / 3, pc: 16, mm: 96 / 25.4, cm: 96 / 2.54, in: 96, em: 16, rem: 16, ex: 8 }

/** 長さ。% は percentOf（ビューポートの幅や高さ）に対する割合。読めなければ null */
export function parseLength(raw: string | undefined, percentOf = 0): number | null {
  if (raw === undefined) return null
  const match = /^\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)\s*(%|[a-z]*)\s*$/i.exec(raw)
  if (!match) return null
  const value = Number(match[1])
  const unit = match[2].toLowerCase()
  if (unit === '%') return (value / 100) * percentOf
  const scale = UNITS[unit]
  return scale === undefined ? null : value * scale
}

/** 空白やカンマで区切った数の並び（points・viewBox など）。読めない値があれば null */
export function parseNumbers(raw: string | undefined): number[] | null {
  if (raw === undefined) return null
  const parts = raw.match(/[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?|[^\s,]+/g) ?? []
  const numbers = parts.map(Number)
  return numbers.every(Number.isFinite) ? numbers : null
}

/** 割合（0〜1）。50% と 0.5 の両方を受け付ける */
export function parseFraction(raw: string | undefined): number | null {
  if (raw === undefined) return null
  const value = parseFloat(raw)
  if (!Number.isFinite(value)) return null
  return raw.trim().endsWith('%') ? value / 100 : value
}

// ── transform ──

/** transform 属性。読めない書き方なら null（SVG の決まりどおり、その transform は無視する） */
export function parseTransform(raw: string | undefined): Matrix | null {
  if (raw === undefined || raw.trim() === '' || raw.trim() === 'none') return IDENTITY
  const pattern = /\s*(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)\s*,?/gy
  let matrix: Matrix = IDENTITY
  let end = 0
  for (const match of raw.matchAll(pattern)) {
    const args = parseNumbers(match[2])
    if (!args) return null
    const next = transformFunction(match[1], args)
    if (!next) return null
    // 左に書いたものが外側（最後にかかる）
    matrix = multiply(matrix, next)
    end = match.index + match[0].length
  }
  return end === raw.length ? matrix : null
}

function transformFunction(name: string, args: number[]): Matrix | null {
  const rad = (degrees: number) => (degrees * Math.PI) / 180
  switch (name) {
    case 'matrix':
      return args.length === 6 ? (args as unknown as Matrix) : null
    case 'translate':
      return args.length === 1 || args.length === 2 ? [1, 0, 0, 1, args[0], args[1] ?? 0] : null
    case 'scale':
      return args.length === 1 || args.length === 2 ? [args[0], 0, 0, args[1] ?? args[0], 0, 0] : null
    case 'rotate': {
      if (args.length !== 1 && args.length !== 3) return null
      const cos = Math.cos(rad(args[0]))
      const sin = Math.sin(rad(args[0]))
      const turn: Matrix = [cos, sin, -sin, cos, 0, 0]
      if (args.length === 1) return turn
      const [, cx, cy] = args
      return multiply(multiply([1, 0, 0, 1, cx, cy], turn), [1, 0, 0, 1, -cx, -cy])
    }
    case 'skewX':
      return args.length === 1 ? [1, 0, Math.tan(rad(args[0])), 1, 0, 0] : null
    case 'skewY':
      return args.length === 1 ? [1, Math.tan(rad(args[0])), 0, 1, 0, 0] : null
  }
  return null
}

/**
 * 変換を「回転 + 縦横の拡大」として読めるときの、その中身。軸が直交していない（歪めている）か、
 * 裏返している（行列式が負）ときは null。rect や ellipse を回転だけのノードで表せるかの判定に使う
 */
export function decompose(m: Matrix): { rotation: number; scaleX: number; scaleY: number } | null {
  const [a, b, c, d] = m
  const scaleX = Math.hypot(a, b)
  const scaleY = Math.hypot(c, d)
  if (scaleX === 0 || scaleY === 0) return null
  if (Math.abs(a * c + b * d) > 1e-9 * scaleX * scaleY) return null
  if (a * d - b * c <= 0) return null
  return { rotation: (Math.atan2(b, a) * 180) / Math.PI, scaleX, scaleY }
}

/** 線の太さや文字の大きさにかける倍率（面積の比の平方根） */
export function lengthScale(m: Matrix): number {
  return Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]))
}

// ── style 属性 ──

/** style 属性を「名前 → 値」にする。!important は外す */
export function parseStyle(raw: string | undefined): Record<string, string> {
  const result: Record<string, string> = {}
  if (!raw) return result
  for (const declaration of raw.split(';')) {
    const colon = declaration.indexOf(':')
    if (colon < 0) continue
    const name = declaration.slice(0, colon).trim().toLowerCase()
    const value = declaration.slice(colon + 1).replace(/!important\s*$/i, '').trim()
    if (name !== '' && value !== '') result[name] = value
  }
  return result
}
