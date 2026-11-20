import { parseKdr } from '../document/kdr.ts'
import type { DesignDocument } from '../document/types.ts'
import { serializeKdr } from './exportKdr.ts'

// 編集中のドキュメントはブラウザに自動保存する。中身は kdr と同じ JSON（圧縮なし）
const STORAGE_KEY = 'kadrokreo:document'

export function loadSavedDocument(): DesignDocument | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw === null ? null : parseKdr(JSON.parse(raw))
  } catch {
    // 壊れた保存データや localStorage が使えない環境では、空のドキュメントから始める
    return null
  }
}

/** 保存できたかどうかを返す */
export function saveDocument(doc: DesignDocument): boolean {
  try {
    localStorage.setItem(STORAGE_KEY, serializeKdr(doc))
    return true
  } catch {
    return false
  }
}
