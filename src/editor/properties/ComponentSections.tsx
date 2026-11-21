import { type MainNode, findMain, isInstance, isMain } from '../../document/component.ts'
import type { Page } from '../../document/types.ts'
import {
  type VariantProperty,
  isBooleanProperty,
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
  nestedInstanceOf,
  pushOverrides,
  resetOverrides,
  swapComponent,
  swapNestedInstance,
} from '../components.ts'
import { fitTextNodes } from '../measure.ts'
import {
  addVariant,
  addVariantProperty,
  removeVariantProperty,
  renameVariantProperty,
  selectVariant,
  setVariantValue,
} from '../variants.ts'
import { type PanelContext, MIXED } from './context.ts'
import { CheckField, OverrideMark, Section, SelectField, TextField } from './fields.tsx'

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
  const { store, state, page, nodes } = ctx
  const { overridden, reset, push } = overrideActions(ctx)
  // 1 つだけ選んでいる中身が、元と違えている項目
  const changedKeys = [...ctx.overridden]
  // 1 つだけ選んでいる中身が、元の中に置いたインスタンスの写しなら、別のコンポーネントに差し替えられる
  const nested = nodes.length === 1 ? nestedInstanceOf(state.document, page, nodes[0].id) : null
  return (
    <Section title="インスタンスの中身">
      <p className="section-note">
        文言・塗り・線の色・表示・文字の書式・画像を、このインスタンスに限って変えられます。文言はダブルクリックで編集します。
      </p>
      {nested && (
        <ComponentSelect
          label="元"
          ariaLabel="入れ子のインスタンスの元"
          ctx={ctx}
          value={nested.componentId}
          overridden={nested.componentId !== nested.originalId}
          allowed={nested.allowed}
          onChange={(componentId) =>
            store.applyDocument((doc) => swapNestedInstance(doc, page.id, nodes[0].id, componentId))
          }
        />
      )}
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
          {variantProperties(page, variantSet.id).map((property, _, all) => (
            <div key={property.name} className="variant-property">
              <TextField
                label={isBooleanProperty(property) ? '真偽' : `${property.values.length} 値`}
                value={property.name}
                onCommit={(next) =>
                  store.apply((base) => renameVariantProperty(base, variantSet.id, property.name, next))
                }
              />
              <button
                type="button"
                className="icon-button"
                title={all.length > 1 ? 'このプロパティを消す（すべてのバリアントの名前から外す）' : '最後のプロパティは消せません'}
                aria-label={`プロパティ ${property.name} を消す`}
                disabled={all.length <= 1}
                onClick={() => store.apply((base) => removeVariantProperty(base, variantSet.id, property.name))}
              >
                ×
              </button>
            </div>
          ))}
          <div className="variant-actions">
            <button
              type="button"
              title="すべてのバリアントの名前に「プロパティ=標準」を書き足す"
              onClick={() => store.apply((base) => addVariantProperty(base, variantSet.id).scene)}
            >
              プロパティを追加
            </button>
            <button type="button" onClick={() => addVariantOf(variantsIn(page, variantSet.id).at(-1)!.id)}>
              バリアントを追加
            </button>
          </div>
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
                (parseVariantName(single.name) ?? []).map(([key, value]) =>
                  booleanIn(variantProperties(page, variantMainSet.id), key) ? (
                    <CheckField
                      key={key}
                      label={key}
                      value={value === 'true'}
                      onChange={(checked) =>
                        store.apply((base) => setVariantValue(base, single.id, key, String(checked)))
                      }
                    />
                  ) : (
                    <TextField
                      key={key}
                      label={key}
                      value={value}
                      onCommit={(next) => store.apply((base) => setVariantValue(base, single.id, key, next))}
                    />
                  ),
                )}
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
                variantProperties(instanceMain.page, instanceSet.id).map((property) => {
                  const { name, values } = property
                  const current = propValue(parseVariantName(instanceMain.node.name) ?? [], name)
                  const choose = (value: string) =>
                    store.applyDocument((doc) => selectVariant(doc, page.id, single.id, name, value))
                  return isBooleanProperty(property) ? (
                    <CheckField
                      key={name}
                      label={name}
                      value={current === undefined ? MIXED : current === 'true'}
                      onChange={(checked) => choose(String(checked))}
                    />
                  ) : (
                    <SelectField
                      key={name}
                      label={name}
                      value={current ?? MIXED}
                      options={values.map((value) => [value, value] as const)}
                      onChange={choose}
                    />
                  )
                })}
              <ComponentSelect
                label="元"
                ariaLabel="インスタンスの元"
                ctx={ctx}
                value={single.component.id}
                // 差し替えると、このインスタンスが入っている元を、新しい元が含むことになるものは選べない
                allowed={(componentId) =>
                  single.parentId === null || canHoldInstance(state.document, page, single.parentId, componentId)
                }
                onChange={(componentId) =>
                  store.applyDocument((doc) => swapComponent(doc, page.id, single.id, componentId))
                }
              />
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

/** プロパティ key が真偽値（値が true / false だけ）か */
function booleanIn(properties: readonly VariantProperty[], key: string): boolean {
  const property = properties.find((candidate) => candidate.name === key)
  return property !== undefined && isBooleanProperty(property)
}

type ComponentSelectProps = {
  label: string
  ariaLabel: string
  ctx: PanelContext
  /** いまの元のコンポーネントの id */
  value: string
  overridden?: boolean
  /** 選べるコンポーネントか（選べないものは灰色で出す） */
  allowed: (componentId: string) => boolean
  onChange: (componentId: string) => void
}

/** インスタンスの元を、ドキュメントにあるコンポーネントから選ぶ欄 */
function ComponentSelect({ label, ariaLabel, ctx, value, overridden, allowed, onChange }: ComponentSelectProps) {
  return (
    <label className="field">
      <span className="field-label">
        {label}
        <OverrideMark show={overridden} />
      </span>
      <select
        aria-label={ariaLabel}
        value={value}
        onChange={(event) => {
          onChange(event.target.value)
          // フォーカスを残すとキーボードショートカットが効かなくなる
          event.target.blur()
        }}
      >
        {listComponents(ctx.state.document).map(({ page: mainPage, node }) => (
          <option
            key={node.component.id}
            value={node.component.id}
            disabled={node.component.id !== value && !allowed(node.component.id)}
          >
            {optionName(mainPage, node)}
          </option>
        ))}
      </select>
    </label>
  )
}

/** 元を選ぶ欄での名前。バリアントなら「まとまりの名前（バリアントの名前）」 */
function optionName(page: Page, node: MainNode): string {
  const set = variantSetOf(page, node.id)
  return set ? `${set.name}（${node.name}）` : node.name
}
