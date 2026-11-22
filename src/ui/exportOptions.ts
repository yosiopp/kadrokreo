import { useSyncExternalStore } from 'react'

// 書き出しのオプション（画面の書き出し欄のチェック）。viewer と editor の「PNG に」「SVG に」「SVG をコピー」で共有し、
// ブラウザに覚えておく（次に開いたときも同じ）。ids は SVG だけ（document/svgExport.ts の SvgExportOptions）、background は PNG と SVG の両方に効く

export type ExportOptions = {
  /** レイヤー名から作る id を付けるか（CLI の --no-ids の逆） */
  ids: boolean
  /** 範囲全体に敷く背景の色（PNG と SVG）。null なら透明（CLI の png / svg-out の --background） */
  background: string | null
}

// 名前は SVG だけのオプションだったころのまま（覚えた設定を引き継ぐ）
const KEY = 'kadrokreo.svgOptions'
const DEFAULTS: ExportOptions = { ids: true, background: null }
const listeners = new Set<() => void>()
let current: ExportOptions = load()

function load(): ExportOptions {
  try {
    const raw = JSON.parse(globalThis.localStorage?.getItem(KEY) ?? 'null') as Partial<ExportOptions> | null
    if (!raw || typeof raw !== 'object') return DEFAULTS
    return {
      ids: typeof raw.ids === 'boolean' ? raw.ids : DEFAULTS.ids,
      background: typeof raw.background === 'string' && /^#[0-9a-f]{6}$/i.test(raw.background) ? raw.background : null,
    }
  } catch {
    return DEFAULTS
  }
}

/** いまのオプション */
export function getExportOptions(): ExportOptions {
  return current
}

/** オプションを変えて覚える */
export function setExportOptions(patch: Partial<ExportOptions>): void {
  current = { ...current, ...patch }
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(current))
  } catch {
    // 覚えられなくても、このページを開いているあいだは効く
  }
  for (const listener of listeners) listener()
}

/** 画面でオプションを読む（変わると描き直す） */
export function useExportOptions(): ExportOptions {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getExportOptions,
  )
}
