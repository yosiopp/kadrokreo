import type { DesignDocument, ModeSelection, VariableCollection } from '../../document/types.ts'
import { setFrameMode, setPageMode } from '../operations/variables.ts'
import type { EditorStore } from '../store.ts'
import type { PanelContext } from './context.ts'
import { common } from './context.ts'
import { Section, SelectField } from './fields.tsx'

/** 指定しない（モードの id には空白が入らないので、ぶつからない） */
const INHERIT = ' '

/** モードが 2 つ以上あるコレクション（切り替えられるもの） */
function switchable(document: DesignDocument): VariableCollection[] {
  return document.collections.filter((collection) => collection.modes.length > 1)
}

function modeOptions(collection: VariableCollection, inherit: string): [string, string][] {
  return [[INHERIT, inherit], ...collection.modes.map((mode): [string, string] => [mode.id, mode.name])]
}

/** フレームで使う変数のモード（コレクションごと）。指定しなければ親（無ければページ）に従う */
export function FrameModesSection({ ctx }: { ctx: PanelContext }) {
  const collections = switchable(ctx.state.document)
  if (collections.length === 0 || !ctx.nodes.every((node) => node.type === 'frame')) return null
  return (
    <Section title="変数のモード">
      {collections.map((collection) => (
        <SelectField
          key={collection.id}
          label={collection.name}
          value={common(ctx.nodes.map((node) => (node.type === 'frame' ? node.modes?.[collection.id] : undefined) ?? INHERIT))}
          options={modeOptions(collection, '親に従う')}
          onChange={(mode) =>
            ctx.store.applyDocument((doc) =>
              ctx.selection.reduce((next, id) => setFrameMode(next, ctx.page.id, id, collection.id, mode === INHERIT ? null : mode), doc),
            )
          }
        />
      ))}
    </Section>
  )
}

/** ページで使う変数のモード（何も選んでいないときのプロパティパネル）。指定しなければ最初のモード */
export function PageModesSection({ store, document, pageId, modes }: { store: EditorStore; document: DesignDocument; pageId: string; modes: ModeSelection | undefined }) {
  const collections = switchable(document)
  if (collections.length === 0) return null
  return (
    <Section title="このページのモード">
      {collections.map((collection) => (
        <SelectField
          key={collection.id}
          label={collection.name}
          value={modes?.[collection.id] ?? INHERIT}
          options={modeOptions(collection, `指定しない（${collection.modes[0].name}）`)}
          onChange={(mode) => store.applyDocument((doc) => setPageMode(doc, pageId, collection.id, mode === INHERIT ? null : mode))}
        />
      ))}
    </Section>
  )
}
