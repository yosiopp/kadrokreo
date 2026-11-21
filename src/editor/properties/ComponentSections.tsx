import { type MainNode, findMain, isInstance, isMain } from '../../document/component.ts'
import type { Page } from '../../document/types.ts'
import {
  isVariantSet,
  parseVariantName,
  propValue,
  variantProperties,
  variantSetOf,
  variantsIn,
} from '../../document/variants.ts'
import { OVERRIDE_LABELS } from '../../ui/labels.ts'
import {
  canHoldInstance,
  createInstance,
  detachComponent,
  hasOverrides,
  listComponents,
  makeComponent,
  overriddenKeys,
  pushOverrides,
  resetOverrides,
  swapComponent,
} from '../components.ts'
import { fitTextNodes } from '../measure.ts'
import { addVariant, renameVariantProperty, selectVariant, setVariantValue } from '../variants.ts'
import { type PanelContext, MIXED } from './context.ts'
import { Section, SelectField, TextField } from './fields.tsx'

/** 選んでいるインスタンスや中身の上書きを、戻す・元に書き込む */
function overrideActions({ store, state, page, selection }: PanelContext) {
  return {
    overridden: selection.some((id) => hasOverrides(state.document, page, id)),
    /** 選んでいるインスタンスや、その中身の上書きを捨てる */
    reset: () => store.applyDocument((doc) => resetOverrides(doc, page.id, selection)),
    /** 選んでいるインスタンスや、その中身の上書きを、元に書き込む */
    push: () => store.applyDocument((doc) => pushOverrides(doc, page.id, selection, fitTextNodes)),
  }
}

/** インスタンスの中身（写し）を選んでいるときの節 */
export function InstanceContentSection({ ctx }: { ctx: PanelContext }) {
  const { state, page, nodes } = ctx
  const { overridden, reset, push } = overrideActions(ctx)
  // 1 つだけ選んでいる中身が、元と違えている項目
  const changedKeys = nodes.length === 1 ? overriddenKeys(state.document, page, nodes[0].id) : []
  return (
    <Section title="インスタンスの中身">
      <p className="section-note">
        文言・塗り・線の色・表示・文字の書式・画像を、このインスタンスに限って変えられます。文言はダブルクリックで編集します。
      </p>
      {changedKeys.length > 0 && (
        <p className="section-note override-keys">
          元と違えている項目: {changedKeys.map((key) => OVERRIDE_LABELS[key]).join('・')}
        </p>
      )}
      {overridden && (
        <>
          <button type="button" onClick={reset}>
            元と同じに戻す
          </button>
          <button type="button" title="この値を元に書き込み、ほかのインスタンスにも反映する" onClick={push}>
            元に反映
          </button>
        </>
      )}
    </Section>
  )
}

/** バリアントのまとまり、またはコンポーネント（元・インスタンス）のフレームを 1 つだけ選んでいるときの節 */
export function ComponentSections({ ctx }: { ctx: PanelContext }) {
  const { store, state, page, nodes, inner } = ctx
  const single = nodes.length === 1 ? nodes[0] : null
  const { overridden, reset, push } = overrideActions(ctx)

  /** 元のすぐそばにインスタンスを置いて、それを選ぶ */
  const addInstance = (componentId: string) => {
    let id: string | null = null
    store.applyDocument((doc) => {
      const result = createInstance(doc, page.id, componentId)
      id = result.id
      return result.document
    })
    if (id) store.select([id])
  }
  /** バリアントを増やして、増やしたものを選ぶ */
  const addVariantOf = (mainId: string) => {
    let id: string | null = null
    store.applyDocument((doc) => {
      const result = addVariant(doc, page.id, mainId)
      id = result.id
      return result.document
    })
    if (id) store.select([id])
  }
  /** 元のあるページへ移って、元を選ぶ */
  const selectMain = (componentId: string) => {
    const main = findMain(state.document, componentId)
    if (!main) return
    store.setPage(main.page.id)
    store.select([main.node.id])
  }

  // 1 つだけ選んでいるものが、バリアントのまとまり・バリアント・バリアントのインスタンスなら、そのまとまり
  const variantSet = single && isVariantSet(page, single.id) ? single : null
  const variantMainSet = single && isMain(single) ? variantSetOf(page, single.id) : null
  const instanceMain = single && isInstance(single) ? findMain(state.document, single.component.id) : null
  const instanceSet = instanceMain ? variantSetOf(instanceMain.page, instanceMain.node.id) : null

  return (
    <>
      {variantSet && (
        <Section title="バリアント">
          <p className="section-note">
            中のコンポーネントを、名前の「プロパティ=値」で選び分けられます。プロパティ名を変えると、すべてのバリアントに反映されます。
          </p>
          {variantProperties(page, variantSet.id).map(({ name, values }) => (
            <TextField
              key={name}
              label={`${values.length} 値`}
              value={name}
              onCommit={(next) => store.apply((base) => renameVariantProperty(base, variantSet.id, name, next))}
            />
          ))}
          <button type="button" onClick={() => addVariantOf(variantsIn(page, variantSet.id).at(-1)!.id)}>
            バリアントを追加
          </button>
        </Section>
      )}

      {!inner && single?.type === 'frame' && !variantSet && (
        <Section title="コンポーネント">
          {single.component === null && (
            <button type="button" onClick={() => store.apply((base) => makeComponent(base, single.id))}>
              コンポーネントにする
            </button>
          )}
          {single.component?.role === 'main' && (
            <>
              <p className="section-note">
                {variantMainSet
                  ? `「${variantMainSet.name}」のバリアントです。変更すると、このバリアントのインスタンスに反映されます。`
                  : 'このフレームが元です。変更すると、すべてのインスタンスに反映されます。'}
              </p>
              {variantMainSet &&
                (parseVariantName(single.name) ?? []).map(([key, value]) => (
                  <TextField
                    key={key}
                    label={key}
                    value={value}
                    onCommit={(next) => store.apply((base) => setVariantValue(base, single.id, key, next))}
                  />
                ))}
              <button type="button" onClick={() => addInstance(single.component!.id)}>
                インスタンスを作る
              </button>
              <button
                type="button"
                title="この元を複製して、選び分けられるもう 1 つの形（バリアント）にする"
                onClick={() => addVariantOf(single.id)}
              >
                バリアントを追加
              </button>
              <button type="button" onClick={() => store.apply((base) => detachComponent(base, single.id))}>
                コンポーネントをやめる
              </button>
            </>
          )}
          {single.component?.role === 'instance' && (
            <>
              <p className="section-note">
                インスタンスです。中身は元に合わせて変わります。ダブルクリックで中身を選ぶと、文言や色をこのインスタンスだけ変えられます。
              </p>
              {instanceMain &&
                instanceSet &&
                variantProperties(instanceMain.page, instanceSet.id).map(({ name, values }) => (
                  <SelectField
                    key={name}
                    label={name}
                    value={propValue(parseVariantName(instanceMain.node.name) ?? [], name) ?? MIXED}
                    options={values.map((value) => [value, value] as const)}
                    onChange={(value) =>
                      store.applyDocument((doc) => selectVariant(doc, page.id, single.id, name, value))
                    }
                  />
                ))}
              <label className="field">
                <span className="field-label">元</span>
                <select
                  aria-label="インスタンスの元"
                  value={single.component.id}
                  onChange={(event) => {
                    const componentId = event.target.value
                    store.applyDocument((doc) => swapComponent(doc, page.id, single.id, componentId))
                    // フォーカスを残すとキーボードショートカットが効かなくなる
                    event.target.blur()
                  }}
                >
                  {listComponents(state.document).map(({ page: mainPage, node }) => (
                    <option
                      key={node.component.id}
                      value={node.component.id}
                      // 差し替えると、このインスタンスが入っている元を、新しい元が含むことになる
                      disabled={
                        single.parentId !== null &&
                        !canHoldInstance(state.document, page, single.parentId, node.component.id)
                      }
                    >
                      {optionName(mainPage, node)}
                    </option>
                  ))}
                </select>
              </label>
              <button type="button" onClick={() => selectMain(single.component!.id)}>
                元を表示
              </button>
              {overridden && (
                <>
                  <button type="button" onClick={reset}>
                    上書きをすべて戻す
                  </button>
                  <button
                    type="button"
                    title="このインスタンスの上書きをすべて元に書き込み、ほかのインスタンスにも反映する"
                    onClick={push}
                  >
                    上書きを元に反映
                  </button>
                </>
              )}
              <button type="button" onClick={() => store.apply((base) => detachComponent(base, single.id))}>
                切り離して編集できるようにする
              </button>
            </>
          )}
        </Section>
      )}
    </>
  )
}

/** 元を選ぶ欄での名前。バリアントなら「まとまりの名前（バリアントの名前）」 */
function optionName(page: Page, node: MainNode): string {
  const set = variantSetOf(page, node.id)
  return set ? `${set.name}（${node.name}）` : node.name
}
