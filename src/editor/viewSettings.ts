import { useSyncExternalStore } from 'react'

// editor のキャンバスの表示の設定（ルーラーなど）。ドキュメントの中身ではないので kdr には持たせず、ブラウザに覚えておく

export type ViewSettings = {
  /** キャンバスの上と左にルーラーとガイド線を出すか（隠している間はガイド線に吸着しない） */
  rulers: boolean
  /** フレームのレイアウトグリッドを出すか（隠している間はグリッドに吸着しない） */
  layoutGrids: boolean
}

const KEY = 'kadrokreo.editorView'
// ルーラーは既定では出さない（帯がキャンバスの端に重なり、今までの操作の場所を変えないように）。
// レイアウトグリッドは置いたフレームにだけ出るので、既定で出す
const DEFAULTS: ViewSettings = { rulers: false, layoutGrids: true }
const listeners = new Set<() => void>()
let current: ViewSettings = load()

function load(): ViewSettings {
  try {
    const raw = JSON.parse(globalThis.localStorage?.getItem(KEY) ?? 'null') as Partial<ViewSettings> | null
    if (!raw || typeof raw !== 'object') return DEFAULTS
    return {
      rulers: typeof raw.rulers === 'boolean' ? raw.rulers : DEFAULTS.rulers,
      layoutGrids: typeof raw.layoutGrids === 'boolean' ? raw.layoutGrids : DEFAULTS.layoutGrids,
    }
  } catch {
    return DEFAULTS
  }
}

export function getViewSettings(): ViewSettings {
  return current
}

/** 設定を変えて覚える */
export function setViewSettings(patch: Partial<ViewSettings>): void {
  current = { ...current, ...patch }
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(current))
  } catch {
    // 覚えられなくても、このページを開いているあいだは効く
  }
  for (const listener of listeners) listener()
}

/** 画面で設定を読む（変わると描き直す） */
export function useViewSettings(): ViewSettings {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getViewSettings,
  )
}
