import type { DesignDocument, NodeId, PageId } from '../document/types.ts'

// 見ている場所（ページと選択）を URL のハッシュで表す。kdr ファイルそのものは URL に入らないので、
// リンクを受け取った人が同じ kdr を開いたときに、そのページと選択から始まる。

export type ViewLink = { pageId: PageId | null; selection: NodeId[] }

/** #page=…&select=…,… の形。何もなければ空文字 */
export function formatViewLink(link: ViewLink): string {
  const params = new URLSearchParams()
  if (link.pageId !== null) params.set('page', link.pageId)
  if (link.selection.length > 0) params.set('select', link.selection.join(','))
  const text = params.toString()
  return text === '' ? '' : `#${text}`
}

/** formatViewLink の逆。知らない項目や壊れた値は無視する */
export function parseViewLink(hash: string): ViewLink {
  const params = new URLSearchParams(hash.replace(/^#/, ''))
  const select = params.get('select')
  return {
    pageId: params.get('page') || null,
    selection: select ? select.split(',').filter((id) => id !== '') : [],
  }
}

/**
 * リンクを、開いているドキュメントに当てはめる。選択は、そのページにあるものだけを残す。
 * リンクのページがドキュメントになければ、最初のページで、何も選ばない
 * （ノードの id はページの中でだけ一意なので、別のページの id は当てにならない）。
 */
export function resolveViewLink(doc: DesignDocument, link: ViewLink): { pageId: PageId; selection: NodeId[] } {
  const found = doc.pages.find((candidate) => candidate.id === link.pageId)
  const page = found ?? doc.pages[0]
  const wanted = found || link.pageId === null ? link.selection : []
  const selection = [...new Set(wanted)].filter((id) => Object.hasOwn(page.nodes, id))
  return { pageId: page.id, selection }
}
