// 線の破線（Style.strokeDashes）を、パネルの欄や CLI の略記から書き換えるための計算。
// 並びは CSS・SVG の stroke-dasharray と同じで、数が奇数なら 2 回繰り返した並びとして描く

/** 破線にしたときの最初の並び（線 4px・間隔 4px） */
export const DEFAULT_DASHES: readonly number[] = [4, 4]

/** 奇数個の並びを、描かれるとおりの偶数個に直す（[4] → [4, 4]、[4, 2, 1] → [4, 2, 1, 4, 2, 1]） */
export function evenDashes(dashes: readonly number[]): number[] {
  return dashes.length % 2 === 1 ? [...dashes, ...dashes] : [...dashes]
}

/** 並びが描ける形か（どれも 0 以上の有限の数で、すべて 0 ではない）。描けなければ実線（空）にする */
export function validDashes(dashes: readonly number[]): number[] {
  if (dashes.some((value) => !Number.isFinite(value) || value < 0)) return []
  return dashes.some((value) => value > 0) ? [...dashes] : []
}

/**
 * index 番目（0 = 線の長さ、1 = 間隔）を value にする。並びは偶数個に直してから変える。
 * 実線（空）から変えるなら、最初の並び（DEFAULT_DASHES）に対して変える。すべて 0 になれば実線
 */
export function withDashAt(dashes: readonly number[], index: number, value: number): number[] {
  const base = dashes.length === 0 ? [...DEFAULT_DASHES] : evenDashes(dashes)
  return validDashes(base.with(index, Math.max(0, value)))
}

/**
 * 「4, 2」「4 2」のような文字を並びに直す。空や「none」「null」「0」は実線（空の並び）。読めなければ null
 */
export function parseDashes(text: string): number[] | null {
  const trimmed = text.trim()
  if (trimmed === '' || trimmed === 'none' || trimmed === 'null') return []
  const parts = trimmed.split(/[\s,]+/).filter(Boolean)
  const values = parts.map(Number)
  if (values.some((value) => !Number.isFinite(value) || value < 0)) return null
  return validDashes(values)
}

/** 並びを欄に出す文字にする（「4, 2」） */
export function formatDashes(dashes: readonly number[]): string {
  return dashes.join(', ')
}
