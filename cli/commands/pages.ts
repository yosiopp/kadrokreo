import type { Page } from '../../src/document/types.ts'
import {
  addPage,
  createDocument,
  createPage,
  removePage,
  renameDocument,
  renamePage,
} from '../../src/editor/operations/document.ts'
import { UsageError } from '../args.ts'
import { resolvePage } from '../session.ts'
import { type Command, checkStep, option, positional } from './common.ts'

// ドキュメントとページのコマンド

export const newDocument: Command = {
  name: 'new',
  kind: 'source',
  usage: 'new [名前]',
  summary: '新しいドキュメントを作る（先頭にだけ置ける）',
  run({ session }, step) {
    checkStep(step, { positionals: 1 })
    const name = step.positionals[0] ?? 'Untitled'
    session.applyDocument(() => createDocument(name))
  },
}

export const page: Command = {
  name: 'page',
  kind: 'nav',
  usage: 'page ページ',
  summary: '以降のコマンドが扱うページを切り替える（id・名前・1 から数えた番号）',
  run({ session }, step) {
    checkStep(step, { positionals: 1 })
    session.setPage(resolvePage(session.document, positional(step, 0, 'ページ')).id)
  },
}

export const docName: Command = {
  name: 'doc-name',
  kind: 'edit',
  usage: 'doc-name 名前',
  summary: 'ドキュメントの名前を変える',
  run({ session }, step) {
    checkStep(step, { positionals: 1 })
    const name = positional(step, 0, '名前')
    session.applyDocument((doc) => renameDocument(doc, name))
  },
}

export const pageAdd: Command = {
  name: 'page-add',
  kind: 'edit',
  usage: 'page-add 名前 [--id ID]',
  summary: 'ページを末尾に足し、そのページに切り替える',
  run({ session }, step) {
    checkStep(step, { options: ['id'], positionals: 1 })
    const page: Page = { ...createPage(positional(step, 0, '名前')) }
    const id = option(step, 'id')
    if (id !== undefined) {
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new UsageError(`id には英数字と _ - だけを使えます: ${id}`)
      if (session.document.pages.some((other) => other.id === id)) throw new UsageError(`ページの id が重複しています: ${id}`)
      page.id = id
    }
    session.applyDocument((doc) => addPage(doc, page))
    session.setPage(page.id)
  },
}

export const pageRename: Command = {
  name: 'page-rename',
  kind: 'edit',
  usage: 'page-rename 名前',
  summary: 'いまのページの名前を変える',
  run({ session }, step) {
    checkStep(step, { positionals: 1 })
    const name = positional(step, 0, '名前')
    const pageId = session.page.id
    session.applyDocument((doc) => renamePage(doc, pageId, name))
  },
}

export const pageRm: Command = {
  name: 'page-rm',
  kind: 'edit',
  usage: 'page-rm [ページ]',
  summary: 'ページを消す（省略するといまのページ）。最後の 1 ページは消せない',
  run({ session }, step) {
    checkStep(step, { positionals: 1 })
    const selector = step.positionals[0]
    const page = selector === undefined ? session.page : resolvePage(session.document, selector)
    if (session.document.pages.length === 1) throw new UsageError('page-rm: 最後の 1 ページは消せません')
    session.applyDocument((doc) => removePage(doc, page.id))
  },
}
