import type { Page, PageId } from './types.ts'

/** ドキュメントのページを id で探す。なければ（id が null も）undefined */
export function findPage(doc: { readonly pages: readonly Page[] }, id: PageId | null): Page | undefined {
  return doc.pages.find((page) => page.id === id)
}
