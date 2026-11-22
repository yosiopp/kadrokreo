import { useState } from 'react'
import { type InstanceNode, type MainNode, derivedId, findMain, isInstance, isMain } from '../../document/component.ts'
import { canBindProperty, enclosingMainNode, instanceProperties } from '../../document/componentProperties.ts'
import type { ComponentProperty, Page } from '../../document/types.ts'
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
import { OVERRIDE_LABELS, PROPERTY_TYPE_LABELS } from '../../ui/labels.ts'
import {
  addComponentProperty,
  alignVariantProperties,
  setVariantSetDescription,
  bindComponentProperty,
  moveComponentProperty,
  removeComponentProperty,
  renameComponentProperty,
  setComponentDescription,
  setInstanceProperty,
  setPreferredComponents,
  unbindComponentProperty,
} from '../componentProperties.ts'
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
  addVariantValue,
  moveVariantProperty,
  moveVariantValue,
  removeVariantProperty,
  renameVariantProperty,
  renameVariantValue,
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
  /** まとまりのプロパティに値を足して、足したバリアントを選ぶ */
  const addValueOf = (setId: string, key: string) => {
    let id: string | null = null
    store.applyDocument((doc) => {
      const result = addVariantValue(doc, page.id, setId, key)
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
            中のコンポーネントを、名前の「プロパティ=値」で選び分けられます。プロパティ名・値の名前や順を変えると、すべてのバリアントに反映されます（値の順はバリアントの並び）。
          </p>
          {variantProperties(page, variantSet.id).map((property, index, all) => (
            <div key={property.name} className="variant-property-block">
              <div className="variant-property">
                <TextField
                  label={isBooleanProperty(property) ? '真偽' : `${property.values.length} 値`}
                  value={property.name}
                  onCommit={(next) =>
                    store.apply((base) => renameVariantProperty(base, variantSet.id, property.name, next))
                  }
                />
                <MoveButtons
                  label={`プロパティ ${property.name}`}
                  index={index}
                  count={all.length}
                  onMove={(to) => store.apply((base) => moveVariantProperty(base, variantSet.id, property.name, to))}
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
              <ul className="variant-values" aria-label={`${property.name} の値`}>
                {property.values.map((value, valueIndex) => (
                  <li key={value} className="variant-property">
                    <TextField
                      label="値"
                      value={value}
                      onCommit={(next) =>
                        store.apply((base) => renameVariantValue(base, variantSet.id, property.name, value, next))
                      }
                    />
                    <MoveButtons
                      label={`値 ${value}`}
                      index={valueIndex}
                      count={property.values.length}
                      onMove={(to) =>
                        store.apply((base) => moveVariantValue(base, variantSet.id, property.name, value, to))
                      }
                    />
                  </li>
                ))}
                <li>
                  <button
                    type="button"
                    className="variant-add-value"
                    title="最初のバリアントを複製して、このプロパティを新しい値にする"
                    onClick={() => addValueOf(variantSet.id, property.name)}
                  >
                    値を追加
                  </button>
                </li>
              </ul>
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
            {alignVariantProperties(page, variantSet.id, state.document) !== page && (
              <button
                type="button"
                title="どれかのバリアントにだけあるコンポーネントのプロパティを、すべてのバリアントに足して並びを揃える"
                onClick={() => store.apply((base) => alignVariantProperties(base, variantSet.id, state.document))}
              >
                プロパティを揃える
              </button>
            )}
          </div>
          {variantSet.type === 'frame' && (
            <DescriptionField
              ariaLabel="まとまりの説明"
              value={variantSet.setDescription}
              onCommit={(next) => store.apply((base) => setVariantSetDescription(base, variantSet.id, next))}
            />
          )}
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
              <DescriptionField
                value={single.component.description}
                onCommit={(next) => store.apply((base) => setComponentDescription(base, single.id, next))}
              />
              <MainPropertiesList ctx={ctx} main={single as MainNode} />
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
              {instanceMain && instanceMain.node.component.description !== '' && (
                <p className="section-note component-description" aria-label="コンポーネントの説明">
                  {instanceMain.node.component.description}
                </p>
              )}
              {instanceSet && instanceSet.setDescription !== '' && (
                <p className="section-note component-description" aria-label="まとまりの説明">
                  {instanceSet.setDescription}
                </p>
              )}
              <InstancePropertyFields ctx={ctx} instance={single as InstanceNode} />
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

      {single && <PropertyBindingSection ctx={ctx} />}
    </>
  )
}

/** 元の説明文の欄。複数行で、フォーカスが外れたときに確定する */
function DescriptionField({
  value,
  onCommit,
  ariaLabel = 'コンポーネントの説明',
}: {
  value: string
  onCommit: (value: string) => void
  ariaLabel?: string
}) {
  const [draft, setDraft] = useState<string | null>(null)
  return (
    <label className="field field-stacked">
      <span className="field-label">説明</span>
      <textarea
        aria-label={ariaLabel}
        rows={2}
        placeholder="使い方など"
        value={draft ?? value}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          if (draft !== null && draft !== value) onCommit(draft)
          setDraft(null)
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            const input = event.currentTarget
            setDraft(null)
            requestAnimationFrame(() => input.blur())
          }
        }}
      />
    </label>
  )
}

/** 元のプロパティの一覧（名前を変える・並べ替える・消す、差し替えの候補を選ぶ）。結ぶのは、元の中のノードを選んだときの節で */
function MainPropertiesList({ ctx, main }: { ctx: PanelContext; main: MainNode }) {
  const { store, state, page } = ctx
  const { properties } = main.component
  const set = variantSetOf(page, main.id)
  return (
    <div className="component-properties" aria-label="コンポーネントのプロパティ">
      <span className="field-label">プロパティ</span>
      {properties.length === 0 && (
        <p className="section-note">元の中のノードを選ぶと、文言・表示・入れ子のインスタンスの元をプロパティにできます。</p>
      )}
      {set && (
        <p className="section-note shared-properties-note">
          「{set.name}」のすべてのバリアントで共有します（名前で揃え、結ぶノードはレイヤー名が同じものを対応させます）。
        </p>
      )}
      {properties.map((property, index) => {
        const targets = property.targets.filter((id) => canBindProperty(page, main.id, property.type, id, state.document))
        return (
          <div key={property.name} className="component-property-block">
            <div className="variant-property">
              <TextField
                label={SHORT_TYPE_LABELS[property.type]}
                value={property.name}
                onCommit={(next) => store.apply((base) => renameComponentProperty(base, main.id, property.name, next))}
              />
              <MoveButtons
                label={`プロパティ ${property.name}`}
                index={index}
                count={properties.length}
                onMove={(to) => store.apply((base) => moveComponentProperty(base, main.id, property.name, to))}
              />
              <button
                type="button"
                className="icon-button"
                title={`結んだノード（${targets.length} か所）を選ぶ`}
                aria-label={`プロパティ ${property.name} を結んだノードを選ぶ`}
                disabled={targets.length === 0}
                onClick={() => store.select(targets)}
              >
                {targets.length}
              </button>
              <button
                type="button"
                className="icon-button"
                title="このプロパティを消す（インスタンスの値は、ふつうの上書きとして残る）"
                aria-label={`プロパティ ${property.name} を消す`}
                onClick={() => store.apply((base) => removeComponentProperty(base, main.id, property.name))}
              >
                ×
              </button>
            </div>
            {property.type === 'instance' && <PreferredList ctx={ctx} main={main} property={property} />}
          </div>
        )
      })}
    </div>
  )
}

/**
 * 差し替えのプロパティの候補（既存のデザインツールの preferred values）。インスタンスで選ぶ欄の先頭に、この順で出る。
 * 足す欄では、結んだ入れ子のインスタンスと循環しないコンポーネントだけを選べる
 */
function PreferredList({ ctx, main, property }: { ctx: PanelContext; main: MainNode; property: ComponentProperty }) {
  const { store, state } = ctx
  const components = listComponents(state.document)
  const preferred = property.preferred.flatMap((id) => {
    const found = components.find(({ node }) => node.component.id === id)
    return found ? [found] : []
  })
  const set = (ids: string[]) => store.apply((base) => setPreferredComponents(base, main.id, property.name, ids))
  const ids = preferred.map(({ node }) => node.component.id)
  // 元そのものや、元を含むコンポーネントを候補にすると循環する
  const addable = components.filter(
    ({ node }) => !ids.includes(node.component.id) && canHoldInstance(state.document, ctx.page, main.id, node.component.id),
  )
  return (
    <div className="preferred-components" aria-label={`${property.name} の候補`}>
      <ul>
        {preferred.map(({ page: mainPage, node }, index) => (
          <li key={node.component.id} className="variant-property">
            <span className="property-bound">{optionName(mainPage, node)}</span>
            <MoveButtons
              label={`候補 ${node.name}`}
              index={index}
              count={preferred.length}
              onMove={(to) => {
                const next = ids.filter((id) => id !== node.component.id)
                next.splice(to, 0, node.component.id)
                set(next)
              }}
            />
            <button
              type="button"
              className="icon-button"
              title="候補から外す"
              aria-label={`候補 ${node.name} を外す`}
              onClick={() => set(ids.filter((id) => id !== node.component.id))}
            >
              ×
            </button>
          </li>
        ))}
      </ul>
      <SelectField<string>
        label="候補"
        value=""
        options={[
          ['', preferred.length === 0 ? '候補を足す（なければすべて）' : '候補を足す…'],
          ...addable.map(({ page: mainPage, node }) => [node.component.id, optionName(mainPage, node)] as const),
        ]}
        onChange={(id) => {
          if (id !== '') set([...ids, id])
        }}
      />
    </div>
  )
}

/** インスタンスで、元のプロパティの値を選ぶ欄 */
function InstancePropertyFields({ ctx, instance }: { ctx: PanelContext; instance: InstanceNode }) {
  const { store, state, page } = ctx
  const states = instanceProperties(state.document, page, instance)
  if (states.length === 0) return null
  const set = (name: string, value: string | boolean) =>
    store.applyDocument((doc) => setInstanceProperty(doc, page.id, instance.id, name, value))
  return (
    <>
      {states.map(({ property, value, overridden }) => {
        if (property.type === 'boolean') {
          return (
            <CheckField
              key={property.name}
              label={property.name}
              overridden={overridden}
              value={value === true}
              onChange={(checked) => set(property.name, checked)}
            />
          )
        }
        if (property.type === 'text') {
          return (
            <TextField
              key={property.name}
              label={property.name}
              overridden={overridden}
              value={String(value)}
              onCommit={(next) => set(property.name, next)}
            />
          )
        }
        const main = findMain(state.document, instance.component.id)
        const target = main ? property.targets.find((id) => canBindProperty(main.page, main.node.id, 'instance', id, state.document)) : undefined
        const nested = target === undefined ? null : nestedInstanceOf(state.document, page, derivedId(instance.id, target))
        return (
          <ComponentSelect
            key={property.name}
            label={property.name}
            ariaLabel={`プロパティ ${property.name}`}
            ctx={ctx}
            value={String(value)}
            overridden={overridden}
            preferred={property.preferred}
            allowed={(componentId) => nested?.allowed(componentId) ?? false}
            onChange={(componentId) => set(property.name, componentId)}
          />
        )
      })}
    </>
  )
}

/**
 * 元の中のノード（元そのもの・写しを除く）を 1 つだけ選んでいるときの節。
 * そのノードを、元のプロパティに結ぶ（新しく作るか、種類の合う既存のものに）・外す
 */
function PropertyBindingSection({ ctx }: { ctx: PanelContext }) {
  const { store, state, page, nodes } = ctx
  const node = nodes[0]
  const main = node.parentId === null ? null : enclosingMainNode(page, node.parentId)
  if (!main) return null
  const types = (['text', 'boolean', 'instance'] as const).filter((type) => canBindProperty(page, main.id, type, node.id, state.document))
  if (types.length === 0) return null
  const { properties } = main.component
  const bound = properties.filter((property) => property.targets.includes(node.id))
  const bindable = properties.filter(
    (property) => !property.targets.includes(node.id) && types.includes(property.type),
  )
  const create = (type: ComponentProperty['type']) => store.apply((base) => addComponentProperty(base, main.id, type, node.id, undefined, state.document).scene)
  return (
    <Section title="コンポーネントのプロパティ">
      <p className="section-note">「{main.name}」のプロパティに結ぶと、インスタンスごとに値を選べます。</p>
      {bound.map((property) => (
        <div key={property.name} className="variant-property">
          <span className="property-bound">
            {property.name}
            <span className="field-label">（{PROPERTY_TYPE_LABELS[property.type]}）</span>
          </span>
          <button
            type="button"
            className="icon-button"
            title="このノードをプロパティから外す"
            aria-label={`プロパティ ${property.name} から外す`}
            onClick={() => store.apply((base) => unbindComponentProperty(base, main.id, property.name, node.id))}
          >
            ×
          </button>
        </div>
      ))}
      <div className="variant-actions">
        {types.map((type) => (
          <button key={type} type="button" onClick={() => create(type)}>
            {CREATE_LABELS[type]}
          </button>
        ))}
      </div>
      {bindable.length > 0 && (
        <SelectField<string>
          label="既存に結ぶ"
          value=""
          options={[['', '選ぶ…'], ...bindable.map((property) => [property.name, property.name] as const)]}
          onChange={(name) => {
            if (name !== '') store.apply((base) => bindComponentProperty(base, main.id, name, node.id, state.document))
          }}
        />
      )}
    </Section>
  )
}

/** 元のプロパティの一覧で、名前の欄に添える種類の短い呼び名（並べ替えのボタンが並ぶので、欄が狭くならないように） */
const SHORT_TYPE_LABELS: Record<ComponentProperty['type'], string> = { text: '文言', boolean: '表示', instance: '差し替え' }

const CREATE_LABELS: Record<ComponentProperty['type'], string> = {
  text: '文言をプロパティに',
  boolean: '表示をプロパティに',
  instance: '元をプロパティに',
}

/** 並びの中で 1 つ前・後ろへ移すボタン。前（上）が並びの先頭 */
function MoveButtons({ label, index, count, onMove }: { label: string; index: number; count: number; onMove: (to: number) => void }) {
  if (count <= 1) return null
  return (
    <>
      <button
        type="button"
        className="icon-button"
        aria-label={`${label}を上へ`}
        title="1 つ前へ"
        disabled={index === 0}
        onClick={() => onMove(index - 1)}
      >
        ↑
      </button>
      <button
        type="button"
        className="icon-button"
        aria-label={`${label}を下へ`}
        title="1 つ後ろへ"
        disabled={index === count - 1}
        onClick={() => onMove(index + 1)}
      >
        ↓
      </button>
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
  /** 先頭にまとめて出すコンポーネントの id（差し替えのプロパティの候補）。空ならすべてを 1 つの並びで */
  preferred?: readonly string[]
  /** 選べるコンポーネントか（選べないものは灰色で出す） */
  allowed: (componentId: string) => boolean
  onChange: (componentId: string) => void
}

/** インスタンスの元を、ドキュメントにあるコンポーネントから選ぶ欄。候補があれば先頭に「候補」、残りを「そのほか」に分けて出す */
function ComponentSelect({ label, ariaLabel, ctx, value, overridden, preferred = [], allowed, onChange }: ComponentSelectProps) {
  const components = listComponents(ctx.state.document)
  const option = ({ page: mainPage, node }: { page: Page; node: MainNode }) => (
    <option
      key={node.component.id}
      value={node.component.id}
      disabled={node.component.id !== value && !allowed(node.component.id)}
    >
      {optionName(mainPage, node)}
    </option>
  )
  const first = preferred.flatMap((id) => components.filter(({ node }) => node.component.id === id))
  const rest = components.filter(({ node }) => !preferred.includes(node.component.id))
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
        {first.length === 0 ? (
          components.map(option)
        ) : (
          <>
            <optgroup label="候補">{first.map(option)}</optgroup>
            {rest.length > 0 && <optgroup label="そのほか">{rest.map(option)}</optgroup>}
          </>
        )}
      </select>
    </label>
  )
}

/** 元を選ぶ欄での名前。バリアントなら「まとまりの名前（バリアントの名前）」 */
function optionName(page: Page, node: MainNode): string {
  const set = variantSetOf(page, node.id)
  return set ? `${set.name}（${node.name}）` : node.name
}
