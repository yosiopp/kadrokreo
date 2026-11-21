import { getWorldCenter } from '../../src/document/geometry.ts'
import type { DesignDocument, NodeId } from '../../src/document/types.ts'
import { createInstance, detachComponent, listComponents, makeComponent } from '../../src/editor/components.ts'
import { updateNode } from '../../src/editor/operations/tree.ts'
import { UsageError } from '../args.ts'
import { checkNewId, renameNodeId } from '../session.ts'
import { type Command, checkStep, numberOption, option, positional } from './common.ts'

// コンポーネントのコマンド

export const component: Command = {
  name: 'component',
  kind: 'edit',
  usage: 'component フレーム',
  summary: 'フレームをコンポーネントの元にする',
  run({ session }, step) {
    checkStep(step, { positionals: 1 })
    const id = session.resolveFrame(positional(step, 0, 'フレーム'))
    session.apply((page) => makeComponent(page, id))
  },
}

export const detach: Command = {
  name: 'detach',
  kind: 'edit',
  usage: 'detach フレーム',
  summary: 'コンポーネントとのつながりを外す（元から外すと、インスタンスはただのフレームになる）',
  run({ session }, step) {
    checkStep(step, { positionals: 1 })
    const id = session.resolveFrame(positional(step, 0, 'フレーム'))
    session.apply((page) => detachComponent(page, id))
  },
}

export const instance: Command = {
  name: 'instance',
  kind: 'edit',
  usage: 'instance 元 [--parent フレーム] [--x N --y N] [--id ID] [--name 名前]',
  summary: 'コンポーネントのインスタンスを置く。元は全ページから id か名前で探す。置いたものは「@」で指せる',
  run({ session }, step) {
    checkStep(step, { options: ['parent', 'x', 'y', 'id', 'name'], positionals: 1 })
    const componentId = findComponent(session.document, positional(step, 0, '元'))
    const parent = option(step, 'parent')
    const parentId = parent === undefined ? null : session.resolveFrame(parent)
    const wanted = option(step, 'id')
    if (wanted !== undefined) checkNewId(session.page, wanted)
    const x = numberOption(step, 'x')
    const y = numberOption(step, 'y')
    const name = option(step, 'name')
    const pageId = session.page.id
    let created: NodeId | null = null
    session.applyDocument((doc) => {
      const page = doc.pages.find((candidate) => candidate.id === pageId)!
      const at = parentId === null ? undefined : { center: getWorldCenter(page, parentId), parentId }
      const result = createInstance(doc, pageId, componentId, at)
      if (result.id === null) throw new UsageError('instance: インスタンスを置けません')
      if (parentId !== null && result.document.pages.find((p) => p.id === pageId)!.nodes[result.id].parentId !== parentId) {
        throw new UsageError('instance: そのフレームの中には置けません（インスタンスの中か、元が自分自身を含むことになります）')
      }
      const id = wanted ?? result.id
      created = id
      return {
        ...result.document,
        pages: result.document.pages.map((candidate) => {
          if (candidate.id !== pageId) return candidate
          const renamed = renameNodeId(candidate, result.id!, id)
          const patch = { ...(x === undefined ? {} : { x }), ...(y === undefined ? {} : { y }), ...(name === undefined ? {} : { name }) }
          return updateNode(renamed, id, patch)
        }),
      }
    })
    session.last = created === null ? [] : [created]
  },
}

function findComponent(doc: DesignDocument, selector: string): string {
  const mains = listComponents(doc)
  const byId = mains.filter(({ node }) => node.id === selector || node.component.id === selector)
  const found = byId.length > 0 ? byId : mains.filter(({ node }) => node.name === selector)
  if (found.length === 0) throw new UsageError(`コンポーネントの元が見つかりません: ${selector}`)
  if (found.length > 1) {
    throw new UsageError(`${selector}: 同じ名前の元が ${found.length} 個あります。id で指定してください（${found.map(({ node }) => node.id).join(', ')}）`)
  }
  return found[0].node.component.id
}
