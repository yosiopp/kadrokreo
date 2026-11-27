import type { FrameNode, NodeId, SceneNode, VariableCollection } from '../../document/types.ts'
import { BINDINGS, type BindingKey, acceptsBinding, canBind, resolveVariable, variableIndex, withBoundValue } from '../../document/variables.ts'
import { BINDING_LABELS } from '../../ui/labels.ts'
import { fitTextNodes } from '../measure.ts'
import { type NodePatch, patchNodes } from '../operations/tree.ts'
import type { PanelContext } from './context.ts'
import { common } from './context.ts'
import { Section, SelectField } from './fields.tsx'

/** つながない（変数の id には空白が入らないので、ぶつからない） */
const NONE = ' '

/**
 * 数値・文字・真偽の変数へのつながり。選んでいるどのノードにもある項目ごとに、同じ種類の変数を選ぶ。
 * 色の変数は塗り・線・影の行で選ぶ。数値・文字・真偽の変数が無ければ出さない
 */
export function BindingsSection({ ctx }: { ctx: PanelContext }) {
  const collections = ctx.state.document.collections
  const index = variableIndex(collections)
  const keys = (Object.keys(BINDINGS) as BindingKey[]).filter(
    (key) => ctx.nodes.every((node) => canBind(node, key)) && options(collections, key).length > 0,
  )
  if (keys.length === 0) return null

  function bind(key: BindingKey, variable: string | null) {
    const value = variable === null ? undefined : resolveVariable(index, variable, (collection) => collection.modes[0].id)
    if (variable !== null && !acceptsBinding(key, value)) return
    ctx.store.apply((base) =>
      fitTextNodes(
        patchNodes(base, ctx.selection, (node) => patchOf(node, key, variable, value)),
        ctx.selection.filter((id: NodeId) => base.nodes[id]?.type === 'text'),
      ),
    )
  }

  return (
    <Section title="変数につなぐ">
      {keys.map((key) => (
        <SelectField
          key={key}
          label={BINDING_LABELS[key]}
          value={common(ctx.nodes.map((node) => node.bindings?.[key] ?? NONE))}
          options={[[NONE, '（つながない）'], ...options(collections, key)]}
          onChange={(id) => bind(key, id === NONE ? null : id)}
        />
      ))}
    </Section>
  )
}

/** その項目につなげる変数（種類が合うもの） */
function options(collections: readonly VariableCollection[], key: BindingKey): [string, string][] {
  return collections.flatMap((collection) =>
    collection.variables
      .filter((variable) => variable.type === BINDINGS[key])
      .map((variable): [string, string] => [variable.id, collections.length > 1 ? `${collection.name}: ${variable.name}` : variable.name]),
  )
}

/** ノードの key を変数につなぐ（variable が null なら外す。値はそのまま）patch */
function patchOf(node: SceneNode, key: BindingKey, variable: string | null, value: unknown): NodePatch {
  const bindings = { ...node.bindings }
  if (variable === null) delete bindings[key]
  else bindings[key] = variable
  // 空になれば項目ごと外す（undefined は書き出しでも同期の比べでも「無い」と同じ）
  const patch: Record<string, unknown> = { bindings: Object.keys(bindings).length > 0 ? bindings : undefined }
  if (variable !== null) {
    if (key.startsWith('layout.')) patch.layout = (withBoundValue(node, key, value) as FrameNode).layout
    else patch[key] = value
  }
  return patch as NodePatch
}
