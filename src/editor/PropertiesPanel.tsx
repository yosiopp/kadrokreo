import { isInstance, owningInstance } from '../document/component.ts'
import { TYPE_LABELS } from '../ui/labels.ts'
import { nodeKind } from '../document/path.ts'
import { overriddenKeys } from './components.ts'
import { fitTextNodes } from './measure.ts'
import { type NodePatch, updateNodes } from './operations/tree.ts'
import { AppearanceSections } from './properties/AppearanceSections.tsx'
import { ArrangeSections } from './properties/ArrangeSections.tsx'
import { ComponentSections, InstanceContentSection } from './properties/ComponentSections.tsx'
import type { PanelContext } from './properties/context.ts'
import { ExportSection } from './properties/fields.tsx'
import { FrameSections } from './properties/FrameSections.tsx'
import { TextSection } from './properties/TextSection.tsx'
import type { EditorState, EditorStore } from './store.ts'

// 節ごとの中身は properties/ にある。ここは選択から PanelContext を作り、節を並べるだけ

type Props = {
  store: EditorStore
  state: EditorState
  /** 選択中のもの（何も選んでいなければページ全体）を PNG に書き出す */
  onExportPng: (scale: number) => void
  /** 選んでいる画像を、選んだファイルの画像に差し替える */
  onReplaceImage: (file: File) => void
}

const SHORTCUTS = [
  ['V / F / R / O / L / P / T', 'ツールの切り替え'],
  ['Space + ドラッグ', '画面の移動'],
  ['⌘/Ctrl + ホイール', 'ズーム'],
  ['Shift + 1', '全体を表示'],
  ['⌘/Ctrl + Z', '元に戻す'],
  ['⌘/Ctrl + D', '複製'],
  ['] / [', '最前面 / 最背面へ'],
]

export function PropertiesPanel({ store, state, onExportPng, onReplaceImage }: Props) {
  const { page, selection } = state
  const nodes = selection.map((id) => page.nodes[id])

  if (nodes.length === 0) {
    return (
      <aside className="panel properties-panel" aria-label="プロパティ">
        <h2 className="panel-title">プロパティ</h2>
        <p className="panel-hint">レイヤーを選択すると、位置や色を編集できます。</p>
        <h2 className="panel-title">ショートカット</h2>
        <dl className="shortcut-list">
          {SHORTCUTS.map(([keys, description]) => (
            <div key={keys}>
              <dt>{keys}</dt>
              <dd>{description}</dd>
            </div>
          ))}
        </dl>
        <ExportSection label="このページを PNG に書き出し" onExport={onExportPng} />
      </aside>
    )
  }

  const ctx: PanelContext = {
    store,
    state,
    page,
    selection,
    nodes,
    // 文字やフォントを変えるとテキストの大きさも変わるので、毎回合わせ直す
    apply: (patch: NodePatch) =>
      store.apply((base) => fitTextNodes(updateNodes(base, selection, patch), selection)),
    preview: (patch: NodePatch) => store.preview((base) => updateNodes(base, selection, patch)),
    // インスタンス自身は、上書きできる項目に加えて位置・回転・不透明度を持つ
    hasInstance: nodes.some(isInstance),
    inner: nodes.some((node) => owningInstance(page, node.id) !== null),
    overridden: new Set(nodes.length === 1 ? overriddenKeys(state.document, page, nodes[0].id) : []),
  }

  return (
    <aside className="panel properties-panel" aria-label="プロパティ">
      <h2 className="panel-title">
        {nodes.length === 1 ? TYPE_LABELS[nodeKind(nodes[0])] : `${nodes.length} 個を選択中`}
      </h2>
      {ctx.inner ? <InstanceContentSection ctx={ctx} /> : <ArrangeSections ctx={ctx} />}
      <ComponentSections ctx={ctx} />
      <AppearanceSections ctx={ctx} onReplaceImage={onReplaceImage} />
      <FrameSections ctx={ctx} />
      <TextSection ctx={ctx} />
      <ExportSection label="PNG に書き出し" onExport={onExportPng} />
    </aside>
  )
}
