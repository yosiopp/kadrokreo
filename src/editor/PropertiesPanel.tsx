import { type ReactNode, useEffect, useRef, useState } from 'react'
import { findMain, isInstance, owningInstance } from '../document/component.ts'
import { normalizeAngle, tidy } from '../document/geometry.ts'
import type {
  AutoLayout,
  Gradient,
  Page,
  SceneNode,
  Shadow,
  TextNode,
} from '../document/types.ts'
import { ExportControls } from '../ui/ExportControls.tsx'
import {
  CAP_LABELS,
  FIT_LABELS,
  SIZE_MODE_LABELS,
  TYPE_LABELS,
  alignLabels,
  optionsOf,
} from '../ui/labels.ts'
import {
  createInstance,
  detachComponent,
  hasOverrides,
  makeComponent,
  resetOverrides,
} from './components.ts'
import { enableAutoLayout } from './layout.ts'
import { fitTextNodes } from './measure.ts'
import { AlignIcon, TextAlignIcon } from './icons.tsx'
import {
  type Alignment,
  type NodePatch,
  alignNodes,
  distributeNodes,
  patchNodes,
  setSize,
  updateNode,
  updateNodes,
} from './operations.ts'
import type { EditorState, EditorStore } from './store.ts'

type Props = {
  store: EditorStore
  state: EditorState
  /** 選択中のもの（何も選んでいなければページ全体）を PNG に書き出す */
  onExportPng: (scale: number) => void
}

/** 複数選択で値が揃っていないことを表す */
const MIXED = Symbol('mixed')
type Mixed = typeof MIXED

function common<T>(values: readonly T[]): T | Mixed {
  return values.every((value) => Object.is(value, values[0])) ? values[0] : MIXED
}

const FONT_FAMILIES = [
  { value: 'sans-serif', label: 'ゴシック体' },
  { value: 'serif', label: '明朝体' },
  { value: 'monospace', label: '等幅' },
]

const ALIGNMENTS: { alignment: Alignment; label: string }[] = [
  { alignment: 'left', label: '左揃え' },
  { alignment: 'center', label: '左右中央揃え' },
  { alignment: 'right', label: '右揃え' },
  { alignment: 'top', label: '上揃え' },
  { alignment: 'middle', label: '上下中央揃え' },
  { alignment: 'bottom', label: '下揃え' },
]

const TEXT_ALIGNMENTS: { value: TextNode['textAlign']; label: string }[] = [
  { value: 'left', label: '左寄せ' },
  { value: 'center', label: '中央寄せ' },
  { value: 'right', label: '右寄せ' },
]

const DEFAULT_SHADOW: Shadow = { x: 0, y: 4, blur: 12, color: '#000000', opacity: 0.25 }

const SHORTCUTS = [
  ['V / F / R / O / L / P / T', 'ツールの切り替え'],
  ['Space + ドラッグ', '画面の移動'],
  ['⌘/Ctrl + ホイール', 'ズーム'],
  ['Shift + 1', '全体を表示'],
  ['⌘/Ctrl + Z', '元に戻す'],
  ['⌘/Ctrl + D', '複製'],
  ['] / [', '最前面 / 最背面へ'],
]

export function PropertiesPanel({ store, state, onExportPng }: Props) {
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

  // 文字やフォントを変えるとテキストの大きさも変わるので、毎回合わせ直す
  const apply = (patch: NodePatch) =>
    store.apply((base) => fitTextNodes(updateNodes(base, selection, patch), selection))
  const preview = (patch: NodePatch) => store.preview((base) => updateNodes(base, selection, patch))
  // 大きさを数値で決める。テキストは折り返しに、自動で並べるフレームはその向きが固定になる
  const resize = (size: { width?: number; height?: number }) =>
    store.apply((base) => fitTextNodes(setSize(base, selection, size), selection))

  // インスタンスとその中身（写し）の見た目は元に合わせて作り直されるので、変えられるのは上書きできる項目
  // （塗り・線の色。文言はキャンバスで、表示はレイヤー一覧で変える）だけ。
  // インスタンス自身は、それに加えて位置・回転・不透明度を持つ
  const hasInstance = nodes.some(isInstance)
  const inner = nodes.some((node) => owningInstance(page, node.id) !== null)
  const limited = hasInstance || inner
  const plain = inner ? [] : nodes.filter((node) => !isInstance(node))
  // 塗りと線を持つ図形
  const shapes = nodes.filter(
    (node) => node.type === 'rect' || node.type === 'ellipse' || node.type === 'frame' || node.type === 'path',
  )
  const texts = nodes.filter((node) => node.type === 'text')
  const lines = nodes.filter((node) => node.type === 'line')
  const paths = nodes.filter((node) => node.type === 'path')
  // 端の形を付けられるもの。閉じたパスには端がない
  const capped = [...lines, ...paths.filter((node) => !node.closed)]
  const closed = common(paths.map((node) => node.closed))
  const frames = plain.filter((node) => node.type === 'frame')
  const rounded = plain.filter((node) => node.type === 'rect' || node.type === 'frame' || node.type === 'image')
  const filled = [...shapes, ...texts]
  const stroked = [...shapes, ...lines]
  const onlyShapes = shapes.length === nodes.length
  const hasText = texts.length > 0
  // 直線は水平・垂直にできるよう、幅や高さが 0 でもよい
  const minSize = lines.length > 0 ? 0 : 1
  const fontFamily = common(texts.map((node) => node.fontFamily))
  const autoWidth = common(texts.map((node) => node.autoWidth))
  const fontWeight = common(texts.map((node) => node.fontWeight))
  const textAlign = common(texts.map((node) => node.textAlign))
  const clipContent = common(frames.map((node) => node.clipContent))

  /** 選んでいるノードごとに patch を決めて当てる、ページへの変更。null を返したノードは変えない */
  const patchSelected = (patchFor: (node: SceneNode) => NodePatch | null) => (base: Page) =>
    patchNodes(base, selection, patchFor)

  const layouts = frames.flatMap((node) => (node.layout ? [node.layout] : []))
  const layoutEnabled = common(frames.map((node) => node.layout !== null))
  /** 自動で並べているフレームだけ、設定の一部を書き換える */
  const patchLayouts = (patch: Partial<AutoLayout>) =>
    patchSelected((node) =>
      node.type === 'frame' && node.layout ? { layout: { ...node.layout, ...patch } } : null,
    )
  const toggleLayout = (enabled: boolean) => (base: Page) =>
    selection.reduce(
      (next, id) => (enabled ? enableAutoLayout(next, id) : updateNode(next, id, { layout: null })),
      base,
    )
  /** 設定項目 1 つの、選択中のフレームに共通の値 */
  const layoutValue = <K extends keyof AutoLayout>(key: K) => common(layouts.map((layout) => layout[key]))

  const images = nodes.filter((node) => node.type === 'image')
  const gradients = shapes.flatMap((node) => (node.fillGradient ? [node.fillGradient] : []))
  const gradientEnabled = common(shapes.map((node) => node.fillGradient !== null))
  /** 塗りの色を変える。グラデーションにしている図形は、始まりの色も一緒に変える */
  const fillRecipe = (fill: string | null) =>
    patchSelected((node) => {
      if (!('fill' in node)) return null
      if (node.type === 'text') return fill === null ? null : { fill }
      const fillGradient =
        fill !== null && node.fillGradient ? withStopColor(node.fillGradient, 0, fill) : null
      return { fill, fillGradient }
    })
  /** グラデーションにしている図形だけ、グラデーションを書き換える */
  const patchGradients = (change: (gradient: Gradient) => Gradient) =>
    patchSelected((node) =>
      'fillGradient' in node && node.fillGradient ? { fillGradient: change(node.fillGradient) } : null,
    )
  const toggleGradient = (enabled: boolean) =>
    patchSelected((node) => {
      if (!('fillGradient' in node) || node.fill === null) return null
      if (!enabled) return { fillGradient: null }
      if (node.fillGradient) return null
      // 上から下へ、いまの色から白へ
      const stops = [
        { offset: 0, color: node.fill },
        { offset: 1, color: '#ffffff' },
      ]
      return { fillGradient: { angle: 90, stops } }
    })

  const single = nodes.length === 1 ? nodes[0] : null
  const overridden = selection.some((id) => hasOverrides(state.document, page, id))
  /** 選んでいるインスタンスや、その中身の上書きを捨てる */
  const reset = () => store.applyDocument((doc) => resetOverrides(doc, page.id, selection))
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
  /** 元のあるページへ移って、元を選ぶ */
  const selectMain = (componentId: string) => {
    const main = findMain(state.document, componentId)
    if (!main) return
    store.setPage(main.page.id)
    store.select([main.node.id])
  }

  const shadows = shapes.flatMap((node) => (node.shadow ? [node.shadow] : []))
  const shadowEnabled = common(shapes.map((node) => node.shadow !== null))
  /** 影のある図形だけ、影の一部を書き換える */
  const patchShadows = (patch: Partial<Shadow>) =>
    patchSelected((node) => ('shadow' in node && node.shadow ? { shadow: { ...node.shadow, ...patch } } : null))
  // 1 つだけのときは親フレームに揃えるので、ページ直下では揃える先がない
  const canAlign = nodes.length > 1 || nodes[0].parentId !== null

  return (
    <aside className="panel properties-panel" aria-label="プロパティ">
      <h2 className="panel-title">
        {nodes.length === 1 ? TYPE_LABELS[nodes[0].type] : `${nodes.length} 個を選択中`}
      </h2>

      {inner && (
        <Section title="インスタンスの中身">
          <p className="section-note">
            文言・塗り・線の色・表示だけを、このインスタンスに限って変えられます。文言はダブルクリックで編集します。
          </p>
          {overridden && (
            <button type="button" onClick={reset}>
              元と同じに戻す
            </button>
          )}
        </Section>
      )}

      {!inner && (
        <>
          <Section title="整列">
            <div className="button-row">
              {ALIGNMENTS.map(({ alignment, label }) => (
                <button
                  key={alignment}
                  type="button"
                  className="icon-button"
                  title={label}
                  aria-label={label}
                  disabled={!canAlign}
                  onClick={() => store.apply((base) => alignNodes(base, selection, alignment))}
                >
                  <AlignIcon kind={alignment} />
                </button>
              ))}
              {(['x', 'y'] as const).map((axis) => {
                const label = axis === 'x' ? '左右に等間隔' : '上下に等間隔'
                return (
                  <button
                    key={axis}
                    type="button"
                    className="icon-button"
                    title={label}
                    aria-label={label}
                    disabled={nodes.length < 3}
                    onClick={() => store.apply((base) => distributeNodes(base, selection, axis))}
                  >
                    <AlignIcon kind={axis === 'x' ? 'distribute-x' : 'distribute-y'} />
                  </button>
                )
              })}
            </div>
          </Section>

          <Section title="位置とサイズ">
            <div className="field-grid">
              <NumberField label="X" value={common(nodes.map((n) => n.x))} onCommit={(x) => apply({ x })} />
              <NumberField label="Y" value={common(nodes.map((n) => n.y))} onCommit={(y) => apply({ y })} />
              <NumberField
                label="W"
                value={common(nodes.map((n) => n.width))}
                min={minSize}
                // インスタンスの大きさは元と同じ
                disabled={hasInstance}
                // テキストは幅を決めると、その幅で折り返すようになる
                onCommit={(width) => resize({ width })}
              />
              <NumberField
                label="H"
                value={common(nodes.map((n) => n.height))}
                min={minSize}
                // テキストの高さは中身で決まる
                disabled={hasText || hasInstance}
                onCommit={(height) => resize({ height })}
              />
              <NumberField
                label="回転"
                value={common(nodes.map((n) => n.rotation))}
                onCommit={(rotation) => apply({ rotation: normalizeAngle(rotation) })}
              />
            </div>
          </Section>

          <Section title="不透明度">
            <NumberField
              label="%"
              value={mapValue(common(nodes.map((n) => n.opacity)), (opacity) => Math.round(opacity * 100))}
              min={0}
              max={100}
              onCommit={(percent) => apply({ opacity: percent / 100 })}
            />
          </Section>
        </>
      )}

      {!inner && single?.type === 'frame' && (
        <Section title="コンポーネント">
          {single.component === null && (
            <button type="button" onClick={() => store.apply((base) => makeComponent(base, single.id))}>
              コンポーネントにする
            </button>
          )}
          {single.component?.role === 'main' && (
            <>
              <p className="section-note">
                このフレームが元です。変更すると、すべてのインスタンスに反映されます。
              </p>
              <button type="button" onClick={() => addInstance(single.component!.id)}>
                インスタンスを作る
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
              <button type="button" onClick={() => selectMain(single.component!.id)}>
                元を表示
              </button>
              {overridden && (
                <button type="button" onClick={reset}>
                  上書きをすべて戻す
                </button>
              )}
              <button type="button" onClick={() => store.apply((base) => detachComponent(base, single.id))}>
                切り離して編集できるようにする
              </button>
            </>
          )}
        </Section>
      )}

      {filled.length === nodes.length && (
        <Section title="塗り">
          <ColorField
            label="塗り"
            value={common(filled.map((n) => n.fill))}
            // テキストは塗りを消せない
            nullable={onlyShapes}
            fallback="#d9d9d9"
            onPreview={(fill) => store.preview(fillRecipe(fill))}
            onCommit={store.commitPreview}
            onSet={(fill) => store.apply(fillRecipe(fill))}
          />
          {onlyShapes && shapes.every((node) => node.fill !== null) && (
            <CheckField
              label="グラデーション"
              value={gradientEnabled}
              onChange={(checked) => store.apply(toggleGradient(checked))}
            />
          )}
          {gradients.length > 0 && (
            <>
              <span className="section-title">終わりの色</span>
              <ColorField
                label="グラデーションの終わり"
                value={common(gradients.map((gradient) => gradient.stops.at(-1)!.color))}
                nullable={false}
                fallback="#ffffff"
                onPreview={(color) => store.preview(patchGradients((g) => withStopColor(g, -1, color)))}
                onCommit={store.commitPreview}
                onSet={(color) =>
                  store.apply(patchGradients((g) => withStopColor(g, -1, color ?? '#ffffff')))
                }
              />
              <NumberField
                label="角度"
                value={common(gradients.map((gradient) => gradient.angle))}
                onCommit={(angle) =>
                  store.apply(patchGradients((g) => ({ ...g, angle: normalizeAngle(angle) })))
                }
              />
            </>
          )}
        </Section>
      )}

      {!inner && images.length === nodes.length && (
        <Section title="画像">
          <SelectField
            label="収め方"
            value={common(images.map((node) => node.fit))}
            options={optionsOf(FIT_LABELS)}
            onChange={(fit) => apply({ fit })}
          />
        </Section>
      )}

      {stroked.length === nodes.length && (
        <Section title="線">
          <ColorField
            label="線"
            value={common(stroked.map((n) => n.stroke))}
            // 直線は線を消せない
            nullable={lines.length === 0}
            fallback="#000000"
            onPreview={(stroke) => preview({ stroke })}
            onCommit={store.commitPreview}
            onSet={(stroke) => apply({ stroke })}
          />
          {!limited && (
            <NumberField
              label="太さ"
              value={common(stroked.map((n) => n.strokeWidth))}
              min={0}
              onCommit={(strokeWidth) => apply({ strokeWidth })}
            />
          )}
        </Section>
      )}

      {!inner && capped.length > 0 && capped.length === nodes.length && (
        <Section title="端の形">
          <SelectField
            label="始点"
            options={optionsOf(CAP_LABELS)}
            value={common(capped.map((n) => n.startCap))}
            onChange={(startCap) => apply({ startCap })}
          />
          <SelectField
            label="終点"
            options={optionsOf(CAP_LABELS)}
            value={common(capped.map((n) => n.endCap))}
            onChange={(endCap) => apply({ endCap })}
          />
        </Section>
      )}

      {!inner && paths.length === nodes.length && (
        <Section title="パス">
          <CheckField
            label="最後の頂点を最初の頂点につなぐ"
            value={closed}
            onChange={(checked) => apply({ closed: checked })}
          />
        </Section>
      )}

      {rounded.length === nodes.length && (
        <Section title="角丸">
          <NumberField
            label="半径"
            value={common(rounded.map((n) => n.cornerRadius))}
            min={0}
            onCommit={(cornerRadius) => apply({ cornerRadius })}
          />
        </Section>
      )}

      {onlyShapes && !limited && (
        <Section title="影">
          <CheckField
            label="影を付ける"
            value={shadowEnabled}
            onChange={(checked) => apply({ shadow: checked ? DEFAULT_SHADOW : null })}
          />
          {shadows.length > 0 && (
            <>
              <div className="field-grid">
                <NumberField
                  label="横"
                  value={common(shadows.map((shadow) => shadow.x))}
                  onCommit={(x) => store.apply(patchShadows({ x }))}
                />
                <NumberField
                  label="縦"
                  value={common(shadows.map((shadow) => shadow.y))}
                  onCommit={(y) => store.apply(patchShadows({ y }))}
                />
                <NumberField
                  label="ぼかし"
                  value={common(shadows.map((shadow) => shadow.blur))}
                  min={0}
                  onCommit={(blur) => store.apply(patchShadows({ blur }))}
                />
                <NumberField
                  label="濃さ"
                  value={mapValue(common(shadows.map((shadow) => shadow.opacity)), (opacity) =>
                    Math.round(opacity * 100),
                  )}
                  min={0}
                  max={100}
                  onCommit={(percent) => store.apply(patchShadows({ opacity: percent / 100 }))}
                />
              </div>
              <ColorField
                label="影"
                value={common(shadows.map((shadow) => shadow.color))}
                nullable={false}
                fallback={DEFAULT_SHADOW.color}
                onPreview={(color) => store.preview(patchShadows({ color }))}
                onCommit={store.commitPreview}
                onSet={(color) => store.apply(patchShadows({ color: color ?? DEFAULT_SHADOW.color }))}
              />
            </>
          )}
        </Section>
      )}

      {frames.length === nodes.length && (
        <Section title="フレーム">
          <CheckField
            label="はみ出した中身を隠す"
            value={clipContent}
            onChange={(checked) => apply({ clipContent: checked })}
          />
        </Section>
      )}

      {frames.length === nodes.length && (
        <Section title="オートレイアウト">
          <CheckField
            label="中身を自動で並べる"
            value={layoutEnabled}
            onChange={(checked) => store.apply(toggleLayout(checked))}
          />
          {layouts.length > 0 && (
            <>
              <SelectField
                label="向き"
                value={layoutValue('direction')}
                options={[
                  ['horizontal', '横に並べる'],
                  ['vertical', '縦に並べる'],
                ]}
                onChange={(direction) => store.apply(patchLayouts({ direction }))}
              />
              <NumberField
                label="間隔"
                value={layoutValue('gap')}
                onCommit={(gap) => store.apply(patchLayouts({ gap }))}
              />
              <div className="field-grid">
                <NumberField
                  label="左右"
                  value={layoutValue('paddingX')}
                  min={0}
                  onCommit={(paddingX) => store.apply(patchLayouts({ paddingX }))}
                />
                <NumberField
                  label="上下"
                  value={layoutValue('paddingY')}
                  min={0}
                  onCommit={(paddingY) => store.apply(patchLayouts({ paddingY }))}
                />
              </div>
              <SelectField
                label="揃え"
                value={layoutValue('align')}
                // 向きが混ざっているときは、横に並べるときの呼び名で出す
                options={optionsOf(
                  alignLabels(layoutValue('direction') === 'vertical' ? 'vertical' : 'horizontal'),
                )}
                onChange={(align) => store.apply(patchLayouts({ align }))}
              />
              <SelectField
                label="寄せ"
                value={layoutValue('justify')}
                options={[
                  ['start', '先頭に寄せる'],
                  ['center', '中央に寄せる'],
                  ['end', '末尾に寄せる'],
                  ['space-between', '均等に配る'],
                ]}
                onChange={(justify) => store.apply(patchLayouts({ justify }))}
              />
              <SelectField
                label="幅"
                value={layoutValue('widthMode')}
                options={optionsOf(SIZE_MODE_LABELS)}
                onChange={(widthMode) => store.apply(patchLayouts({ widthMode }))}
              />
              <SelectField
                label="高さ"
                value={layoutValue('heightMode')}
                options={optionsOf(SIZE_MODE_LABELS)}
                onChange={(heightMode) => store.apply(patchLayouts({ heightMode }))}
              />
            </>
          )}
        </Section>
      )}

      {!inner && texts.length === nodes.length && (
        <Section title="テキスト">
          <NumberField
            label="サイズ"
            value={common(texts.map((n) => n.fontSize))}
            min={1}
            max={1000}
            onCommit={(fontSize) => apply({ fontSize })}
          />
          <NumberField
            label="行の高さ"
            value={common(texts.map((n) => n.lineHeight))}
            min={0.5}
            max={5}
            step={0.1}
            onCommit={(lineHeight) => apply({ lineHeight })}
          />
          <div className="button-row">
            <button
              type="button"
              className="icon-button"
              title="太字"
              aria-label="太字"
              aria-pressed={fontWeight === 700}
              onClick={() => apply({ fontWeight: fontWeight === 700 ? 400 : 700 })}
            >
              <b>B</b>
            </button>
            {TEXT_ALIGNMENTS.map(({ value, label }) => (
              <button
                key={value}
                type="button"
                className="icon-button"
                title={label}
                aria-label={label}
                aria-pressed={textAlign === value}
                onClick={() => apply({ textAlign: value })}
              >
                <TextAlignIcon align={value} />
              </button>
            ))}
          </div>
          <SelectField
            label="折り返し"
            value={mapValue(autoWidth, (auto) => (auto ? 'auto' : 'fixed'))}
            options={[
              ['auto', 'しない（幅は自動）'],
              ['fixed', '幅に合わせる'],
            ]}
            onChange={(wrap) => apply({ autoWidth: wrap === 'auto' })}
          />
          <label className="field">
            <span className="field-label">書体</span>
            <select
              value={fontFamily === MIXED ? '' : fontFamily}
              onChange={(event) => {
                apply({ fontFamily: event.target.value })
                // フォーカスを残すとキーボードショートカットが効かなくなる
                event.target.blur()
              }}
            >
              {fontFamily === MIXED && <option value="">混在</option>}
              {typeof fontFamily === 'string' && !FONT_FAMILIES.some((f) => f.value === fontFamily) && (
                <option value={fontFamily}>{fontFamily}</option>
              )}
              {FONT_FAMILIES.map((font) => (
                <option key={font.value} value={font.value}>
                  {font.label}
                </option>
              ))}
            </select>
          </label>
        </Section>
      )}
      <ExportSection label="PNG に書き出し" onExport={onExportPng} />
    </aside>
  )
}

/** index 番目（負なら後ろから）の色を変えたグラデーション */
function withStopColor(gradient: Gradient, index: number, color: string): Gradient {
  const at = index < 0 ? gradient.stops.length + index : index
  return { ...gradient, stops: gradient.stops.with(at, { ...gradient.stops[at], color }) }
}

function ExportSection({ label, onExport }: { label: string; onExport: (scale: number) => void }) {
  const [scale, setScale] = useState(1)
  return (
    <Section title="書き出し">
      <ExportControls scale={scale} onScaleChange={setScale} onExport={() => onExport(scale)}>
        {label}
      </ExportControls>
    </Section>
  )
}

type SelectFieldProps<T extends string> = {
  label: string
  value: T | Mixed
  /** [値, 表示名] の並び */
  options: readonly (readonly [T, string])[]
  onChange: (value: T) => void
}

function SelectField<T extends string>({ label, value, options, onChange }: SelectFieldProps<T>) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <select
        value={value === MIXED ? '' : value}
        onChange={(event) => {
          onChange(event.target.value as T)
          // フォーカスを残すとキーボードショートカットが効かなくなる
          event.target.blur()
        }}
      >
        {value === MIXED && <option value="">混在</option>}
        {options.map(([option, name]) => (
          <option key={option} value={option}>
            {name}
          </option>
        ))}
      </select>
    </label>
  )
}

type CheckFieldProps = {
  label: string
  value: boolean | Mixed
  onChange: (checked: boolean) => void
}

/** 選んでいるもので値が揃っていなければ、どちらでもない印にする */
function CheckField({ label, value, onChange }: CheckFieldProps) {
  return (
    <label className="check-field">
      <input
        type="checkbox"
        checked={value === true}
        ref={(input) => {
          if (input) input.indeterminate = value === MIXED
        }}
        onChange={(event) => onChange(event.target.checked)}
      />
      {label}
    </label>
  )
}

function mapValue<T, U>(value: T | Mixed, map: (value: T) => U): U | Mixed {
  return value === MIXED ? MIXED : map(value as T)
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="panel-section">
      <h3 className="section-title">{title}</h3>
      {children}
    </section>
  )
}

type NumberFieldProps = {
  label: string
  value: number | Mixed
  min?: number
  max?: number
  /** 上下キーで増減する量。Shift でその 10 倍 */
  step?: number
  disabled?: boolean
  onCommit: (value: number) => void
}

/** 入力中は下書きとして持ち、Enter かフォーカスが外れたときに確定する */
function NumberField({
  label,
  value,
  min = -Infinity,
  max = Infinity,
  step = 1,
  disabled,
  onCommit,
}: NumberFieldProps) {
  const [draft, setDraft] = useState<string | null>(null)
  const shown = draft ?? (value === MIXED ? '' : String(tidy(value)))

  function commit(text: string | null) {
    setDraft(null)
    if (text === null || text.trim() === '') return
    const parsed = Number(text)
    if (!Number.isFinite(parsed)) return
    // 0.1 刻みの足し算で出る端数を落とす
    onCommit(tidy(Math.min(max, Math.max(min, parsed))))
  }

  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <input
        type="text"
        inputMode="decimal"
        value={shown}
        placeholder={value === MIXED ? '混在' : undefined}
        disabled={disabled}
        onFocus={(event) => event.target.select()}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => commit(draft)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.currentTarget.blur()
          } else if (event.key === 'Escape') {
            // 下書きを捨てた後で blur させる（先に blur すると下書きが確定してしまう）
            const input = event.currentTarget
            setDraft(null)
            requestAnimationFrame(() => input.blur())
          } else if ((event.key === 'ArrowUp' || event.key === 'ArrowDown') && value !== MIXED) {
            event.preventDefault()
            const delta = step * (event.shiftKey ? 10 : 1) * (event.key === 'ArrowUp' ? 1 : -1)
            const current = draft === null ? value : Number(draft)
            commit(String((Number.isFinite(current) ? current : value) + delta))
          }
        }}
      />
    </label>
  )
}

type ColorFieldProps = {
  label: string
  value: string | null | Mixed
  nullable: boolean
  /** 色がない状態から有効にしたときの色 */
  fallback: string
  /** 色を選んでいる最中。履歴には積まない */
  onPreview: (color: string) => void
  onCommit: () => void
  onSet: (color: string | null) => void
}

function ColorField({ label, value, nullable, fallback, onPreview, onCommit, onSet }: ColorFieldProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const onCommitRef = useRef(onCommit)
  useEffect(() => {
    onCommitRef.current = onCommit
  })

  // React の onChange は選んでいる最中にも呼ばれる。選び終えたことは素の change イベントで知る
  useEffect(() => {
    const input = inputRef.current
    const commit = () => onCommitRef.current()
    input?.addEventListener('change', commit)
    return () => input?.removeEventListener('change', commit)
  }, [])

  const color = typeof value === 'string' ? value : fallback
  return (
    <div className="color-field">
      {nullable && (
        <input
          type="checkbox"
          aria-label={`${label}を有効にする`}
          checked={value !== null}
          onChange={(event) => onSet(event.target.checked ? color : null)}
        />
      )}
      <input
        ref={inputRef}
        type="color"
        aria-label={`${label}の色`}
        value={color}
        disabled={value === null}
        onChange={(event) => onPreview(event.target.value)}
        onBlur={onCommit}
      />
      <span className="color-value">
        {value === MIXED ? '混在' : value === null ? 'なし' : value.toUpperCase()}
      </span>
    </div>
  )
}
