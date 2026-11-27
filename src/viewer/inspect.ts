import { type InstanceNode, OVERRIDE_KEYS, derivedId, findMain, instanceOf, isMain } from '../document/component.ts'
import { type PropertyValue, canBindProperty, instanceProperties } from '../document/componentProperties.ts'
import { type Point, type Size, getCorners, getNodesBounds, invert, nodeMatrix, tidy } from '../document/geometry.ts'
import { BOOLEAN_OPERATION_LABELS, booleanParts, drawnNode, isBooleanNode } from '../document/booleanNode.ts'
import { type MaskNode, clipsByOutline, isMaskNode, maskContours, maskFillRule, maskOf } from '../document/mask.ts'
import { maskImageSvg } from '../document/svgExport.ts'
import { type ColorFormat, formatColor } from './colors.ts'
import { type BindingKey, acceptsBinding, boundValue, cssVariableName, isBindingKey, resolveVariable, variableIndex } from '../document/variables.ts'
import { CONTRAST_AA, CONTRAST_AAA, CONTRAST_AAA_LARGE, CONTRAST_AA_LARGE, formatRatio, textContrast } from './contrast.ts'
import type { CodeFormat } from './codeFormat.ts'
import { type Distance, measureCorners } from './distances.ts'
import { cssFontFamily } from './fontFamily.ts'
import { followsConstraints, hugs, sizeLimited, stretchedAxes, wraps } from '../document/autoLayout.ts'
import { codeOfComponent } from '../document/codeComponent.ts'
import { isVariantSet, parseVariantName, variantProperties, variantSetOf, variantsIn } from '../document/variants.ts'
import type { Asset, AssetId, AutoLayout, CodeComponent, ComponentProperty, CornerRadius, DesignDocument, Gradient, ImageNode, LayoutGrid, NodeId, Override, Paint, RadialGradient, Scene, SceneNode, Shadow, TextNode, VariableCollection, VariableId } from '../document/types.ts'
import { isPassThroughFrame, passThroughFade } from '../document/passThrough.ts'
import { angleLine, blurRadius, gradientLine, hasStroke, isAngleLine, isGradient, isRounded, isShadow, linearAngle, paintColor, splitEffects, withoutHidden } from '../document/paint.ts'
import { capMarkerSize, contoursData, isLine, isMarkerCap, strokeLineCap } from '../document/path.ts'
import { ALIGN_CONTENT_LABELS, BINDING_LABELS, BLEND_MODE_LABELS, CAP_LABELS, CONSTRAINT_LABELS, EFFECT_TYPE_LABELS, FIT_LABELS, JOIN_LABELS, MASK_TYPE_LABELS, OVERRIDE_LABELS, PROPERTY_TYPE_LABELS, SIZING_LABELS, alignLabels } from '../ui/labels.ts'

// viewer で見せる、ノードの設定の一覧と CSS。どちらもドキュメントを読むだけで、変更はしない。

/** color を付けると、値の横に色見本を出す。nodes を付けると、それらのノードを選ぶボタンを出す */
export type InspectRow = { label: string; value: string; color?: string; nodes?: NodeId[] }
export type InspectSection = { title: string; rows: InspectRow[] }

const DIRECTIONS = { horizontal: '横', vertical: '縦' }
const JUSTIFY = { start: '先頭', center: '中央', end: '末尾', 'space-between': '均等' }
const TEXT_ALIGN = { left: '左', center: '中央', right: '右' }
const TEXT_DECORATION = { underline: '下線', 'line-through': '取り消し線' }

/** 自動で並べるフレームの揃え方を CSS の flex の値に */
const FLEX_JUSTIFY = { start: 'flex-start', center: 'center', end: 'flex-end', 'space-between': 'space-between' } as const

/** CSS の長さの単位 */
export type Unit = 'px' | 'rem'

/** CSS の書き方。remBase は 1rem が何 px か。format はコードの出力形式（markup.ts の nodeCode / nodeMarkup が使う） */
/**
 * コードの書き方。variables を渡すと、変数につないだ色を var(--名前) で書く（渡さなければ値で書く）
 */
export type CodeStyle = { unit: Unit; remBase: number; color: ColorFormat; format: CodeFormat; variables?: readonly VariableCollection[] }
export const DEFAULT_CODE_STYLE: CodeStyle = { unit: 'px', remBase: 16, color: 'hex', format: 'html' }

/** 小数 2 桁まで。計算で出る細かい端数は見せない */
function num(value: number): string {
  return String(tidy(value))
}

/** 字間（px と、文字の大きさに対する em） */
function letterSpacingText(node: TextNode): string {
  return `${num(node.letterSpacing)}px（${num(node.letterSpacing / node.fontSize)}em）`
}

function percent(ratio: number): string {
  return `${num(ratio * 100)}%`
}

/** ノードの設定を、見出しごとにまとめる。その種類のノードにない項目や、既定のままで意味のない項目は出さない */
export function inspectNode(
  doc: DesignDocument,
  scene: Scene,
  id: NodeId,
  format: ColorFormat = 'hex',
): InspectSection[] {
  // 隠した塗り・線・効果は出さない。ブーリアン演算のノードは結果の形のパスとして見せる（演算は別の見出しに出す）
  const original = scene.nodes[id]
  const node = withoutHidden(drawnNode(scene, original))
  const hex = (color: string) => formatColor(color, format, { upper: true })
  // 変数につないだ色は、変数の名前を前に添える（color/primary · #5B4CF5）
  const index = variableIndex(doc.collections)
  const named = (text: string, variable: VariableId | undefined) => {
    const entry = variable === undefined ? undefined : index.get(variable)
    return entry ? `${entry.variable.name} · ${text}` : text
  }
  const sections: InspectSection[] = []
  const add = (title: string, rows: (InspectRow | false | null)[]) => {
    const shown = rows.filter((row) => row !== false && row !== null)
    if (shown.length > 0) sections.push({ title, rows: shown })
  }

  const stretched = stretchedAxes(scene, node)
  // 親いっぱいに伸ばしている向きは、値のあとに書き添える
  const fillNote = (on: boolean) => (on ? '（親いっぱい）' : '')
  add('位置とサイズ', [
    { label: 'X', value: num(node.x) },
    { label: 'Y', value: num(node.y) },
    { label: '幅', value: `${num(node.width)}${fillNote(stretched.width)}` },
    { label: '高さ', value: `${num(node.height)}${fillNote(stretched.height)}` },
    ...limitRows(scene, node),
    inFlexParent(scene, node.id) && node.layoutPositioning === 'absolute' && { label: '配置', value: '並びから外す' },
    ...constraintRows(scene, node),
    node.rotation !== 0 && { label: '回転', value: `${num(node.rotation)}°` },
    (node.type === 'text' || node.type === 'image') && (node.flipX || node.flipY) &&
      { label: '裏返し', value: flipText(node) },
    'cornerRadius' in node && isRounded(node.cornerRadius) && { label: '角丸', value: radiusText(node.cornerRadius, num) },
    node.opacity < 1 && { label: '不透明度', value: percent(node.opacity) },
    node.blendMode !== 'normal' && { label: '描画モード', value: BLEND_MODE_LABELS[node.blendMode] },
    node.type === 'frame' && node.passThrough && node.blendMode === 'normal' && { label: '描画モード', value: '通過' },
    isPassThroughFrame(node) && {
      label: 'CSS',
      value: passThroughFade(scene, node) !== null
        ? '子が重ならないので、opacity を子に配って書いている（子の描画モードも後ろに効く）'
        : 'opacity は中身をまとめてから混ぜるので、子が重なる通過（子が後ろと直接混ざる）は表せない',
    },
  ])

  if (node.type === 'frame' && node.layout?.mode === 'grid') {
    const { layout } = node
    add('オートレイアウト', [
      { label: '並べ方', value: 'グリッド' },
      { label: '列', value: String(layout.columns) },
      { label: '列の幅', value: layout.columnWidth === null ? '等分' : num(layout.columnWidth) },
      { label: '列の間隔', value: num(layout.gap) },
      { label: '行の間隔', value: num(layout.crossGap) },
      { label: '余白', value: paddingText(layout) },
      { label: '揃え', value: alignLabels('horizontal')[layout.align] },
      layout.columnWidth !== null && { label: '寄せ', value: JUSTIFY[layout.justify] },
      { label: '幅', value: SIZING_LABELS[node.sizing.width] },
      { label: '高さ', value: SIZING_LABELS[node.sizing.height] },
    ])
  } else if (node.type === 'frame' && node.layout) {
    const { layout } = node
    add('オートレイアウト', [
      { label: '向き', value: DIRECTIONS[layout.direction] },
      { label: '間隔', value: num(layout.gap) },
      { label: '余白', value: paddingText(layout) },
      { label: '揃え', value: alignLabels(layout.direction)[layout.align] },
      { label: '寄せ', value: JUSTIFY[layout.justify] },
      wraps(node) && { label: '折り返し', value: `する（行の間隔 ${num(layout.crossGap)}）` },
      wraps(node) && layout.alignContent !== 'auto' && { label: '行の配置', value: ALIGN_CONTENT_LABELS[layout.alignContent] },
      { label: '幅', value: SIZING_LABELS[node.sizing.width] },
      { label: '高さ', value: SIZING_LABELS[node.sizing.height] },
    ])
  }

  if (original.type === 'frame' && original.layoutGrids.length > 0) {
    // レイアウトグリッドは見た目を作らないので、CSS・コードには出さず、値だけを見せる
    add('レイアウトグリッド', original.layoutGrids.map((grid, i) => ({ label: original.layoutGrids.length === 1 ? '種類' : `${i + 1}`, value: layoutGridText(grid) })))
  }

  if (node.type === 'text' && node.textPath !== null) {
    // 線に沿う文字は行に並べないので、行の高さ・折り返しは出さない
    add('テキスト', [
      { label: '内容', value: node.text },
      { label: '書体', value: node.fontFamily },
      { label: 'サイズ', value: num(node.fontSize) },
      { label: '太さ', value: String(node.fontWeight) },
      node.letterSpacing !== 0 && { label: '字間', value: letterSpacingText(node) },
      node.textDecoration !== 'none' && { label: '装飾', value: TEXT_DECORATION[node.textDecoration] },
      { label: 'パスに沿う', value: `始まり ${percent(node.textPath.startOffset)}・${node.textPath.closed ? '閉じた線' : '開いた線'}` },
      { label: '行揃え', value: TEXT_ALIGN[node.textAlign] },
      { label: 'CSS', value: '線に沿う文字は CSS で表せないので、HTML では SVG の textPath で書いている' },
    ])
  } else if (node.type === 'text') {
    add('テキスト', [
      { label: '内容', value: node.text },
      { label: '書体', value: node.fontFamily },
      { label: 'サイズ', value: num(node.fontSize) },
      { label: '太さ', value: String(node.fontWeight) },
      {
        label: '行の高さ',
        value: `${num(node.lineHeight)}（${num(node.fontSize * node.lineHeight)}px）`,
      },
      node.letterSpacing !== 0 && { label: '字間', value: letterSpacingText(node) },
      node.textDecoration !== 'none' && { label: '装飾', value: TEXT_DECORATION[node.textDecoration] },
      { label: '行揃え', value: TEXT_ALIGN[node.textAlign] },
      {
        label: '折り返し',
        value:
          node.sizing.width !== 'hug' ? '幅に合わせる' : node.maxWidth !== null ? `最大の幅（${num(node.maxWidth)}）で` : 'しない',
      },
    ])
  }

  // 塗りが重なっていれば、上（手前）のものから並べる
  const paintRows = (paints: readonly Paint[]): InspectRow[] =>
    paints.toReversed().flatMap((paint): InspectRow[] => [
      ...paintRowsOf(paint),
      ...(paint.opacity < 1 ? [{ label: '不透明度', value: percent(paint.opacity) }] : []),
      ...(paint.blendMode !== 'normal' ? [{ label: '描画モード', value: BLEND_MODE_LABELS[paint.blendMode] }] : []),
    ])
  const paintRowsOf = (paint: Paint): InspectRow[] =>
      paint.type === 'solid'
        ? [{ label: '色', value: named(hex(paint.color), paint.variable), color: paint.color }]
        : [
            paint.type === 'linear'
              ? {
                  label: 'グラデーション',
                  value: isAngleLine(paint, node)
                    ? `${num(linearAngle(paint, node))}°`
                    : `${num(linearAngle(paint, node))}°・${percent(paint.x1)} ${percent(paint.y1)} → ${percent(paint.x2)} ${percent(paint.y2)}`,
                }
              : paint.type === 'conic'
                ? { label: '角度のグラデーション', value: `中心 ${percent(paint.cx)} ${percent(paint.cy)}・${num(paint.angle)}°から` }
                : {
                    label: '円形のグラデーション',
                    value:
                      `中心 ${percent(paint.cx)} ${percent(paint.cy)}・半径 ${percent(paint.rx)} ${percent(paint.ry)}` +
                      (paint.angle !== 0 ? `・${num(paint.angle)}° 回す` : '') +
                      (paint.fx !== 0 || paint.fy !== 0 ? `・焦点 ${percent(paint.fx)} ${percent(paint.fy)}` : ''),
                  },
            paint.type === 'radial' && !radialCssExact(paint) && { label: 'CSS', value: '回した楕円は表せないので、回さない楕円で書いている' },
            paint.type === 'radial' && (paint.fx !== 0 || paint.fy !== 0) && { label: 'CSS', value: '焦点は表せないので、中心から始まるグラデーションで書いている' },
            ...paint.stops.map((stop) => ({
              label: percent(stop.offset),
              value: named(stop.opacity < 1 ? `${hex(stop.color)}・不透明度 ${percent(stop.opacity)}` : hex(stop.color), stop.variable),
              color: stop.color,
            })),
          ].filter((row) => row !== false)
  // マスク（自分は描かず、手前の兄弟を形で切り取る）と、かかっているマスク
  const maskId = maskOf(scene, node.id)
  const appliedMask = maskId === null ? null : (scene.nodes[maskId] as MaskNode)
  add('マスク', [
    isMaskNode(node) && { label: '使い方', value: node.visible ? 'マスクとして使う（描かない）' : 'マスク（隠しているのでかけない）' },
    isMaskNode(node) && node.maskType !== 'vector' && { label: '種類', value: MASK_TYPE_LABELS[node.maskType] },
    appliedMask !== null && { label: 'かかるマスク', value: appliedMask.name },
    appliedMask !== null && !clipsByOutline(appliedMask) && {
      label: 'CSS',
      value: `${appliedMask.maskType === 'vector' ? 'テキストの形' : MASK_TYPE_LABELS[appliedMask.maskType]}のマスクは、マスクの絵を SVG にした mask-image で書いている` +
        (appliedMask.type === 'image' || appliedMask.type === 'frame' ? '（画像は data URI で埋め込む）' : ''),
    },
  ])

  if (isBooleanNode(original)) {
    const parts = booleanParts(scene, original)
    add('ブーリアン演算', [
      { label: '演算', value: BOOLEAN_OPERATION_LABELS[original.booleanOperation] },
      { label: '元の図形', value: `${parts.length} 個` },
      original.booleanIncludeStrokes && { label: '線', value: '元の図形の線も含める' },
    ])
  }

  if ('fills' in node) add('塗り', paintRows(node.fills))

  if (node.type === 'text') add('コントラスト', contrastRows(scene, node.id, hex))

  if ('strokes' in node && hasStroke(node)) {
    add('線', [
      ...paintRows(node.strokes),
      { label: '太さ', value: num(node.strokeWidth) },
      node.strokeDashes.length > 0 && { label: '破線', value: node.strokeDashes.map(num).join(', ') },
      node.strokeDashes.length > 0 && node.strokeDashOffset !== 0 && { label: '破線のずれ', value: num(node.strokeDashOffset) },
      node.strokeJoin !== 'miter' && { label: '角の形', value: JOIN_LABELS[node.strokeJoin] },
      'startCap' in node && node.startCap !== 'none' && { label: '始点', value: CAP_LABELS[node.startCap] },
      'endCap' in node && node.endCap !== 'none' && { label: '終点', value: CAP_LABELS[node.endCap] },
      node.type === 'path' && !node.closed && (isMarkerCap(node.startCap) || isMarkerCap(node.endCap)) && {
        label: '端の大きさ',
        value: node.capSize > 0 ? num(node.capSize) : `自動（${num(capMarkerSize(node))}）`,
      },
    ])
  }

  if ('effects' in node) {
    // パスの影は CSS の filter の drop-shadow、テキストの影は text-shadow で書く。どちらも内側の影と広がりは表せない
    const filterShadow = node.type === 'path' || node.type === 'text'
    add(
      '効果',
      node.effects.flatMap((shadow) => [
        { label: '種類', value: EFFECT_TYPE_LABELS[shadow.type] },
        ...(!isShadow(shadow)
          ? [
              { label: 'ぼかし', value: num(shadow.blur) },
              shadow.type === 'background-blur' &&
                node.type === 'text' && { label: 'CSS', value: 'backdrop-filter は枠の内側全体をぼかす（キャンバスでは文字の形の内側だけ）' },
            ]
          : [
        shadow.type === 'inner-shadow' && filterShadow && { label: 'CSS', value: `${node.type === 'text' ? 'text-shadow' : 'filter'} で表せないので、コードに含めていない` },
        { label: '横', value: num(shadow.x) },
        { label: '縦', value: num(shadow.y) },
        { label: 'ぼかし', value: num(shadow.blur) },
        shadow.spread !== 0 && { label: '広がり', value: num(shadow.spread) },
        shadow.spread !== 0 && shadow.type === 'drop-shadow' && filterShadow && {
          label: 'CSS',
          value: `${node.type === 'text' ? 'text-shadow' : 'filter の drop-shadow'} は広がりを表せないので、広がりなしで書いている`,
        },
        {
          label: '色',
          // HEX のときは、色と濃さを分けて出す（濃さは別の値として持っている）
          value: named(
            format === 'hex' ? `${hex(shadow.color)} ${percent(shadow.opacity)}` : formatColor(shadow.color, format, { alpha: shadow.opacity }),
            shadow.variable,
          ),
          color: shadow.color,
        },
        shadow.blendMode !== 'normal' && { label: '描画モード', value: BLEND_MODE_LABELS[shadow.blendMode] },
        shadow.blendMode !== 'normal' && { label: 'CSS', value: '影ごとの描画モードは CSS で表せないので、ふつうに重ねて書いている' },
            ]),
      ]),
    )
  }

  if (node.type === 'image') {
    const asset = doc.assets[node.assetId]
    add('画像', [
      { label: '収め方', value: FIT_LABELS[node.fit] },
      node.fit !== 'stretch' && (node.positionX !== 0.5 || node.positionY !== 0.5) && {
        label: '寄せる位置',
        value: `${percent(node.positionX)} ${percent(node.positionY)}`,
      },
      node.scale !== 1 && { label: '拡大', value: percent(node.scale) },
      asset !== undefined && { label: '形式', value: asset.mime.replace('image/', '').toUpperCase() },
    ])
  }

  if (isMain(node)) {
    const set = variantSetOf(scene, node.id)
    add('コンポーネント', [
      { label: '種類', value: set ? 'バリアント' : '元' },
      set !== null && { label: 'まとまり', value: set.name },
      set !== null && set.setDescription !== '' && { label: 'まとまりの説明', value: set.setDescription },
      ...variantRows(node.name),
      node.component.description !== '' && { label: '説明', value: node.component.description },
      node.component.code !== null && { label: '実装の部品', value: codeText(node.component.code) },
    ])
    add(
      'プロパティ',
      node.component.properties.map((property) => {
        const targets = property.targets.filter((target) => canBindProperty(scene, node.id, property.type, target, doc))
        // 差し替えの候補（preferred values）があれば、名前を書き添える
        const preferred =
          property.type === 'instance'
            ? property.preferred.flatMap((componentId) => (findMain(doc, componentId) ? [propertyText(doc, 'instance', componentId)] : []))
            : []
        return {
          label: property.name,
          value: `${PROPERTY_TYPE_LABELS[property.type]}（${targets.length} か所）${preferred.length > 0 ? `・候補: ${preferred.join(' / ')}` : ''}`,
          nodes: targets,
        }
      }),
    )
  }
  if (isVariantSet(scene, node.id)) {
    add('コンポーネント', [
      { label: '種類', value: 'バリアントのまとまり' },
      ...variantProperties(scene, node.id).map(({ name, values }) => ({ label: name, value: values.join(' / ') })),
      node.type === 'frame' && node.setDescription !== '' && { label: '説明', value: node.setDescription },
      node.type === 'frame' && node.setCode !== null && { label: '実装の部品', value: codeText(node.setCode) },
    ])
    add('プロパティ', sharedPropertyRows(scene, node.id))
  }
  const instance = instanceOf(scene, id)
  if (instance) {
    const main = findMain(doc, instance.component.id)
    const own = instance.id === id
    const overrides = overridesOn(scene, instance, main?.node.id)
    add('コンポーネント', [
      { label: '種類', value: own ? 'インスタンス' : 'インスタンスの中身' },
      !own && { label: 'インスタンス', value: instance.name },
      main !== null && variantSetOf(main.page, main.node.id) === null && { label: '元の名前', value: main.node.name },
      // バリアントのインスタンスは、まとまりの名前と、選んでいるプロパティの値
      ...(main === null ? [] : variantInstanceRows(main.page, main.node)),
      own && main !== null && main.node.component.description !== '' && { label: '説明', value: main.node.component.description },
      // 実装側の部品の対応があれば（コードでは、この部品の呼び出しになる）
      own && codeRow(codeOfComponent(doc, instance.component.id)),
      // 中身を元から鏡に映していれば（写しの位置や向きは映した値で出る）
      own && (instance.component.flipX || instance.component.flipY) && { label: '中身の裏返し', value: flipText(instance.component) },
      // 中身は、そのノード自身が元と違えている項目だけを出す。インスタンス全体の分は、下の一覧で出す
      !own && overrideRow('上書き', overrides.get(id)),
      // 入れ子のインスタンスを別のコンポーネントに差し替えていれば、差し替えた先
      !own && swappedRow(doc, overrides.get(id)),
    ])
    if (own && main !== null) {
      add(
        'プロパティ',
        instanceProperties(doc, scene, instance).map(({ property, value, overridden }) => ({
          label: overridden ? `${property.name}（上書き）` : property.name,
          value: propertyText(doc, property.type, value),
          nodes: property.targets.map((target) => derivedId(instance.id, target)).filter((target) => Object.hasOwn(scene.nodes, target)),
        })),
      )
    }
    if (own) {
      add(
        '上書き',
        [...overrides].map(([target, override]) =>
          overrideRow(scene.nodes[target].name, override),
        ),
      )
    }
  }

  // 数値・文字・真偽の変数につないだ項目
  add(
    '変数',
    Object.entries(original.bindings ?? {}).flatMap(([key, variable]) => {
      const entry = index.get(variable)
      if (!entry || !isBindingKey(key)) return []
      const value = boundValue(original, key)
      return [{ label: BINDING_LABELS[key], value: `${entry.variable.name} · ${typeof value === 'number' ? num(value) : String(value)}` }]
    }),
  )
  return sections
}

/** 裏返しの向きの呼び名 */
function flipText({ flipX, flipY }: { flipX: boolean; flipY: boolean }): string {
  return flipX && flipY ? '左右と上下' : flipX ? '左右' : '上下'
}

/**
 * インスタンスの上書きを、当たっているノード（インスタンス自身か、その中身）の id ごとにまとめる。
 * 上書きは元の側の id で持っているので、写しの id に直す。当たる先がないものは捨てる。
 */
function overridesOn(scene: Scene, instance: InstanceNode, mainId: NodeId | undefined): Map<NodeId, Override> {
  const found = new Map<NodeId, Override>()
  for (const [sourceId, override] of Object.entries(instance.component.overrides)) {
    const target = sourceId === mainId ? instance.id : derivedId(instance.id, sourceId)
    if (Object.hasOwn(scene.nodes, target)) found.set(target, override)
  }
  return found
}

/**
 * まとまりのバリアントが共有するプロパティ（プロパティはバリアントごとに持つが、editor が名前で揃えている）。
 * 名前ごとに、種類と、持っているバリアントの数（全部でなければ）を出す
 */
function sharedPropertyRows(scene: Scene, setId: NodeId): InspectRow[] {
  const variants = variantsIn(scene, setId)
  const found = new Map<string, { type: ComponentProperty['type']; count: number }>()
  for (const variant of variants) {
    for (const property of variant.component.properties) {
      const entry = found.get(property.name)
      if (entry) entry.count++
      else found.set(property.name, { type: property.type, count: 1 })
    }
  }
  return [...found].map(([name, { type, count }]) => ({
    label: name,
    value: `${PROPERTY_TYPE_LABELS[type]}${count < variants.length ? `（${variants.length} 個のうち ${count} 個のバリアント）` : ''}`,
  }))
}

/** プロパティの値の表し方。真偽値は表示・非表示、差し替えはコンポーネントの名前 */
function propertyText(doc: DesignDocument, type: ComponentProperty['type'], value: PropertyValue): string {
  if (type === 'boolean') return value ? '表示' : '非表示'
  if (type === 'text') return String(value)
  const main = findMain(doc, String(value))
  return main ? mainLabel(main) : '（なし）'
}

/** 元のコンポーネントの呼び名。バリアントなら「まとまりの名前（バリアントの名前）」 */
function mainLabel(main: { page: Scene; node: SceneNode }): string {
  const set = variantSetOf(main.page, main.node.id)
  return set ? `${set.name}（${main.node.name}）` : main.node.name
}

/** 入れ子のインスタンスの差し替え先の行。バリアントなら「まとまりの名前（バリアントの名前）」。差し替えていなければ null */
function swappedRow(doc: DesignDocument, override: Override | undefined): InspectRow | null {
  const swapped = override?.componentId === undefined ? null : findMain(doc, override.componentId)
  return swapped ? { label: '差し替えた元', value: mainLabel(swapped) } : null
}

/** 元と違えている項目の名前を並べた行。何も違えていなければ null */
function overrideRow(label: string, override: Override | undefined): InspectRow | null {
  const keys = OVERRIDE_KEYS.filter((key) => override?.[key] !== undefined)
  return keys.length === 0 ? null : { label, value: keys.map((key) => OVERRIDE_LABELS[key]).join('・') }
}

/**
 * ノードの見た目を CSS で表す。実装するときの手がかりにするためのもので、
 * 直線とパスは CSS で形を描けないので、SVG に指定するプロパティ（stroke など）で表す。
 */
export function nodeCss(scene: Scene, id: NodeId, options: Partial<CodeStyle> = {}, assets: Record<AssetId, Asset> = {}): string {
  const style = { ...DEFAULT_CODE_STYLE, ...options }
  // 隠した塗り・線・効果は書かない。ブーリアン演算のノードは結果の形のパス（SVG）として書く
  const node = withoutHidden(drawnNode(scene, scene.nodes[id]))
  const parent = node.parentId === null ? null : scene.nodes[node.parentId]
  const lines: string[] = []
  const add = (property: string, value: string) => lines.push(`${property}: ${value};`)
  const px = (value: number) => length(value, style)
  // 変数につないだ項目は var(--名前) で書く（style.variables があるとき）。変数は単位を持たないので、長さは calc で px（rem）にする
  // 入れられない値になるモードのある変数（ノードには前の値が残る）は、var で書くと食い違うので値で書く
  const bound = (key: BindingKey): string | undefined => {
    const variable = node.bindings?.[key]
    if (variable === undefined || !style.variables || !acceptedInEveryMode(style.variables, variable, key)) return undefined
    return variableCssName(style.variables, variable)
  }
  const lengthOf = (key: BindingKey, value: number, scale = 1) => {
    const name = bound(key)
    if (name === undefined) return px(value * scale)
    const factor = style.unit === 'rem' ? `${Math.round((scale / style.remBase) * 10000) / 10000}rem` : `${num(scale)}px`
    return `calc(var(${name}) * ${factor})`
  }
  /** オートレイアウトの余白。どこか 1 辺でもつないでいれば、4 辺とも書く（2・3 個に縮めると辺とつながりの対応がずれる。4 辺とも同じなら 1 つ） */
  const layoutPadding = (layout: AutoLayout): string | null => {
    const sides = ['layout.paddingTop', 'layout.paddingRight', 'layout.paddingBottom', 'layout.paddingLeft'] as const
    const fourSides = [layout.paddingTop, layout.paddingRight, layout.paddingBottom, layout.paddingLeft]
    const boundSides = fourSides.map((value, k) => lengthOf(sides[k], value))
    if (!sides.some((side) => bound(side) !== undefined)) return paddingCss(layout, px)
    return boundSides.every((side) => side === boundSides[0]) ? boundSides[0] : boundSides.join(' ')
  }

  const plainOf = (key: BindingKey, value: string) => {
    const name = bound(key)
    return name === undefined ? value : `var(${name})`
  }

  // 自動で並べるフレームの子は、親が位置を決める（並びから外したものを除く）。ページ直下のものは、置き場所を決めない
  const absolute = parent !== null && followsConstraints(parent, node)
  const holdsAbsolute = node.type === 'frame' && node.children.some((child) => followsConstraints(node, scene.nodes[child]))
  // 親の辺への追従（constraints）で決めた大きさは、width / height の代わりに書く
  const sizedBy = { width: false, height: false }
  if (absolute && parent.type === 'frame') {
    add('position', 'absolute')
    for (const axis of ['horizontal', 'vertical'] as const) {
      const [startProp, endProp, sizeProp] = axis === 'horizontal' ? ['left', 'right', 'width'] as const : ['top', 'bottom', 'height'] as const
      const start = axis === 'horizontal' ? node.x : node.y
      const size = node[sizeProp]
      const whole = parent[sizeProp]
      // 回した子の左右・上下と拡大縮小は、editor では囲む矩形で伸縮する（constraints.ts の followRotated）。
      // CSS では回した枠の大きさを親の大きさから決められないので、大きさは今のまま、中心が追従する位置だけを書く
      const rotated = node.rotation !== 0
      const constraint = rotated && node.constraints[axis] === 'stretch' ? 'center' : node.constraints[axis]
      if (rotated && constraint === 'scale') {
        const center = whole === 0 ? 0 : (start + size / 2) / whole
        add(startProp, `calc(${percent(center)} - ${px(size / 2)})`)
        continue
      }
      switch (constraint) {
        case 'start':
          add(startProp, px(start))
          break
        case 'end':
          add(endProp, px(whole - start - size))
          break
        case 'stretch':
          add(startProp, px(start))
          add(endProp, px(whole - start - size))
          sizedBy[sizeProp] = true
          break
        case 'center': {
          // 親の中心からのずれ
          const offset = tidy(start - whole / 2)
          add(startProp, offset === 0 ? '50%' : `calc(50% ${offset < 0 ? '-' : '+'} ${px(Math.abs(offset))})`)
          break
        }
        case 'scale':
          add(startProp, percent(whole === 0 ? 0 : start / whole))
          if (whole !== 0) {
            add(sizeProp, percent(size / whole))
            sizedBy[sizeProp] = true
          }
          break
      }
    }
  } else if (holdsAbsolute) {
    // 子を absolute で置くための基準にする
    add('position', 'relative')
  }

  if (node.type === 'frame' && node.layout?.mode === 'grid') {
    const { layout } = node
    add('display', 'grid')
    add(
      'grid-template-columns',
      layout.columnWidth === null ? `repeat(${layout.columns}, minmax(0, 1fr))` : `repeat(${layout.columns}, ${px(layout.columnWidth)})`,
    )
    // セルの中では左に寄せ、縦は揃え方に従う。行は上から詰める（どれも既定の stretch だと描画と合わない）
    add('align-items', layout.align)
    add('justify-items', 'start')
    add('align-content', 'start')
    if (layout.columnWidth !== null && layout.justify !== 'start') add('justify-content', layout.justify)
    // gap は「行の間隔 列の間隔」の順。変数につないでいれば、値が同じでも分けて書く
    const gapBound = bound('layout.gap') !== undefined || bound('layout.crossGap') !== undefined
    if (layout.crossGap !== layout.gap || (gapBound && bound('layout.gap') !== bound('layout.crossGap'))) {
      add('gap', `${lengthOf('layout.crossGap', layout.crossGap)} ${lengthOf('layout.gap', layout.gap)}`)
    } else if (layout.gap !== 0 || gapBound) add('gap', lengthOf('layout.gap', layout.gap))
    const padding = layoutPadding(layout)
    if (padding !== null) add('padding', padding)
  } else if (node.type === 'frame' && node.layout) {
    const { layout } = node
    const wrapping = wraps(node)
    add('display', 'flex')
    add('flex-direction', layout.direction === 'horizontal' ? 'row' : 'column')
    if (wrapping) add('flex-wrap', 'wrap')
    if (layout.align !== 'start') add('align-items', FLEX_JUSTIFY[layout.align])
    // 折り返すとき、行のまとまりも揃え方に従って置く（既定の stretch だと行の間に隙間ができる）
    if (wrapping) add('align-content', layout.alignContent === 'space-between' ? 'space-between' : FLEX_JUSTIFY[layout.align])
    if (layout.justify !== 'start') add('justify-content', FLEX_JUSTIFY[layout.justify])
    if (wrapping && layout.crossGap !== layout.gap) {
      // gap は「行の間隔 列の間隔」の順
      const [row, column] =
        layout.direction === 'horizontal' ? [layout.crossGap, layout.gap] : [layout.gap, layout.crossGap]
      const [rowKey, columnKey] = layout.direction === 'horizontal' ? (['layout.crossGap', 'layout.gap'] as const) : (['layout.gap', 'layout.crossGap'] as const)
      add('gap', `${lengthOf(rowKey, row)} ${lengthOf(columnKey, column)}`)
    } else if (layout.gap !== 0 || bound('layout.gap') !== undefined) add('gap', lengthOf('layout.gap', layout.gap))
    const padding = layoutPadding(layout)
    if (padding !== null) add('padding', padding)
  }

  // 中身で決まる大きさは書かない
  const hugWidth = hugs(node, 'width') || (node.type === 'text' && node.sizing.width === 'hug')
  const hugHeight = hugs(node, 'height') || (node.type === 'text' && node.sizing.height === 'hug')
  // 親いっぱいに伸ばす向きは、大きさの代わりに伸ばし方を書く
  const stretched = stretchedAxes(scene, node)
  if (parent?.type === 'frame' && parent.layout?.mode === 'grid') {
    if (stretched.width) add('justify-self', 'stretch')
    if (stretched.height) add('align-self', 'stretch')
  } else if (parent?.type === 'frame' && parent.layout) {
    const mainStretched = parent.layout.direction === 'horizontal' ? stretched.width : stretched.height
    const crossStretched = parent.layout.direction === 'horizontal' ? stretched.height : stretched.width
    if (mainStretched) add('flex', '1 0 0')
    if (crossStretched) add('align-self', 'stretch')
  }
  if (!hugWidth && !stretched.width && !sizedBy.width) add('width', px(node.width))
  if (!hugHeight && !stretched.height && !sizedBy.height) add('height', px(node.height))
  // 大きさの下限・上限は、大きさを自動で決める向きでだけ書く
  const limited = sizeLimited(scene, node)
  for (const [property, value, axis] of [
    ['min-width', node.minWidth, 'width'],
    ['max-width', node.maxWidth, 'width'],
    ['min-height', node.minHeight, 'height'],
    ['max-height', node.maxHeight, 'height'],
  ] as const) {
    if (value !== null && limited[axis]) add(property, px(value))
  }
  // テキスト・画像の裏返しは、回転のあとに書く scale（回してから裏返すのではなく、裏返した中身を回す）
  const flip = flipOf(node)
  const transforms = [node.rotation !== 0 && `rotate(${num(node.rotation)}deg)`, flip && `scale(${flip.x}, ${flip.y})`].filter((t) => typeof t === 'string')
  if (transforms.length > 0) add('transform', transforms.join(' '))
  // 子に配れる通過のフレームは、自分の opacity を書かずに子に掛ける（passThrough.ts）
  const opacity = (passThroughFade(scene, scene.nodes[id]) === null ? node.opacity : 1) * inheritedFade(scene, node)
  if (opacity < 1 || (opacity === node.opacity && bound('opacity') !== undefined)) add('opacity', opacity === node.opacity ? plainOf('opacity', num(opacity)) : num(opacity))
  // 塗りが 1 つだけなら、塗りの描画モードは要素ごと後ろに混ぜるのと同じ（ノードの描画モードが normal のとき）
  const fills = 'fills' in node ? node.fills : []
  const blend = node.blendMode !== 'normal' ? node.blendMode : fills.length === 1 && node.type !== 'path' ? fills[0].blendMode : 'normal'
  if (blend !== 'normal') add('mix-blend-mode', blend)
  // 塗りが 2 つ以上なら、上の塗りは background-blend-mode で下の塗りに混ぜる（一番下の塗りを後ろに混ぜることは CSS では表せない）
  if (fills.length > 1 && node.type !== 'path' && node.type !== 'text' && fills.some((fill) => fill.blendMode !== 'normal')) {
    add('background-blend-mode', fills.toReversed().map((fill) => fill.blendMode).join(', '))
  }

  if (node.type === 'text') {
    const top = node.fills.at(-1)
    if (node.fills.some(isGradient)) {
      // 文字のグラデーション（や重ねた塗り）は、背景を文字の形で切り抜いて表す
      add('background', backgroundCss(node.fills, style, node)!)
      add('background-clip', 'text')
      add('color', 'transparent')
    } else if (top?.type === 'solid') add('color', topColorCss(top, style))
    add('font-family', plainOf('fontFamily', cssFontFamily(node.fontFamily)))
    add('font-size', lengthOf('fontSize', node.fontSize))
    add('font-weight', plainOf('fontWeight', String(node.fontWeight)))
    if (node.letterSpacing !== 0 || bound('letterSpacing') !== undefined) add('letter-spacing', lengthOf('letterSpacing', node.letterSpacing))
    // 線に沿う文字の装飾は、svg の中の text に属性で書く（CSS の text-decoration は svg の中の文字へ伝わらない。markup.ts）
    if (node.textDecoration !== 'none' && node.textPath === null) add('text-decoration', node.textDecoration)
    // 線に沿う文字は SVG の textPath で並べる（markup.ts）ので、行の高さ・行揃えは CSS に書かない
    if (node.textPath === null) {
      add('line-height', plainOf('lineHeight', num(node.lineHeight)))
      if (node.textAlign !== 'left') add('text-align', node.textAlign)
    }
    // 中身に合わせる幅は、上限があればそこで折り返す（max-width は上で書いている）
    if (node.sizing.width === 'hug') {
      if (node.maxWidth === null) add('white-space', 'nowrap')
      else add('width', 'max-content')
    }
  } else if (node.type === 'image') {
    add('object-fit', node.fit === 'stretch' ? 'fill' : node.fit)
    if (node.fit !== 'stretch' && (node.positionX !== 0.5 || node.positionY !== 0.5)) {
      add('object-position', `${percent(node.positionX)} ${percent(node.positionY)}`)
    }
    if (node.scale !== 1) add('object-view-box', imageViewBox(node))
  } else if (node.type === 'path') {
    // SVG の fill や stroke にはグラデーションを直接書けないので、いちばん上の塗りの始まりの色で代える
    const fill = node.fills.at(-1)
    const stroke = node.strokes.at(-1)
    if (!isLine(node)) add('fill', fill ? topColorCss(fill, style) : 'none')
    add('stroke', stroke ? topColorCss(stroke, style) : 'none')
    if (stroke) add('stroke-width', lengthOf('strokeWidth', node.strokeWidth))
    if (stroke && node.strokeDashes.length > 0) add('stroke-dasharray', node.strokeDashes.map(px).join(' '))
    if (stroke && node.strokeDashes.length > 0 && node.strokeDashOffset !== 0) add('stroke-dashoffset', px(node.strokeDashOffset))
    if (stroke && node.strokeJoin !== 'miter') add('stroke-linejoin', node.strokeJoin)
    // 両端が同じ丸・四角なら stroke-linecap（破線なら切れ目の端にも付く。描画と同じ）。矢印などの印は SVG の図形で描く
    const lineCap = stroke ? strokeLineCap(node) : null
    if (lineCap !== null) add('stroke-linecap', lineCap)
    if (fill && node.fillRule === 'evenodd') add('fill-rule', 'evenodd')
  } else {
    const background = backgroundCss(node.fills, style, node)
    if (background !== null) add('background', background)
    const stroke = node.strokes.at(-1)
    if (stroke && hasStroke(node)) {
      // 線は枠の辺の上に、内と外へ半分ずつ引く（描画と同じ）。border だと box-sizing しだいで内か外に寄り、
      // 中身の置き場所も狭まるので、場所を取らない outline を、太さの半分だけ内側へずらして使う。
      // outline は色を 1 つしか持てないので、いちばん上の線の色（グラデーションなら始まりの色）で代える
      // 破線は CSS の dashed で代える（線と空きの長さは指定できない）
      const lineStyle = node.strokeDashes.length > 0 ? 'dashed' : 'solid'
      add('outline', `${lengthOf('strokeWidth', node.strokeWidth)} ${lineStyle} ${topColorCss(stroke, style)}`)
      add('outline-offset', lengthOf('strokeWidth', node.strokeWidth, -0.5))
    }
  }

  if (node.type === 'ellipse') add('border-radius', '50%')
  else if ('cornerRadius' in node && typeof node.cornerRadius === 'number' && bound('cornerRadius') !== undefined) add('border-radius', lengthOf('cornerRadius', node.cornerRadius))
  else if ('cornerRadius' in node && isRounded(node.cornerRadius)) add('border-radius', radiusText(node.cornerRadius, px))
  if ('effects' in node && node.effects.length > 0) {
    // CSS は先に書いた影が手前。効果は先頭が奥なので、逆に並べる。内側の影は inset（box-shadow ではどの落ち影よりも手前に描かれる）
    const filters: string[] = []
    // レイヤーのぼかしは影も含めてぼかす（描画と同じ）。CSS の blur() の値は半径の半分（標準偏差）
    const layerBlur = blurRadius(node.effects, 'layer-blur')
    // transform の scale は影のずれも裏返すので、影のずれ（ページの向き）を先に裏返して打ち消す
    const unflip = (shadow: Shadow): Shadow => (flip ? { ...shadow, x: shadow.x * flip.x || 0, y: shadow.y * flip.y || 0 } : shadow)
    const drops = splitEffects(node.effects).drop.toReversed().map(unflip)
    if (node.type === 'path') {
      // パスの影は、枠ではなく形に沿って落ちる。filter の drop-shadow には内側の影と広がりがないので、落ち影だけを広がりなしで
      filters.push(...drops.map((shadow) => `drop-shadow(${shadowCss({ ...shadow, spread: 0 }, style)})`))
    } else if (node.type === 'text') {
      // 文字の影は text-shadow。内側の影と広がりは表せない
      if (drops.length > 0) add('text-shadow', drops.map((shadow) => shadowCss({ ...shadow, spread: 0 }, style)).join(', '))
    } else {
      const shadows = node.effects.filter(isShadow).toReversed().map(unflip)
      if (shadows.length > 0) add('box-shadow', shadows.map((shadow) => shadowCss(shadow, style)).join(', '))
    }
    if (layerBlur > 0) filters.push(`blur(${length(tidy(layerBlur / 2), style)})`)
    if (filters.length > 0) add('filter', filters.join(' '))
    const backgroundBlur = blurRadius(node.effects, 'background-blur')
    if (backgroundBlur > 0) add('backdrop-filter', `blur(${length(tidy(backgroundBlur / 2), style)})`)
  }
  if (node.type === 'frame' && node.clipContent && node.children.length > 0) add('overflow', 'hidden')
  // かかっているマスクは、マスクの形を自分の枠の座標に直した clip-path にする
  const maskId = maskOf(scene, node.id)
  if (maskId !== null) {
    const mask = scene.nodes[maskId] as MaskNode
    const m = invert(nodeMatrix(node))
    if (clipsByOutline(mask)) {
      const d = contoursData(maskContours(mask, m))
      add('clip-path', `path(${maskFillRule(mask) === 'evenodd' ? 'evenodd, ' : ''}'${d}')`)
    } else {
      // 不透明度・明るさのマスクとテキストの形のマスクは、マスクの絵を自分の枠に合わせた SVG にして mask-image に書く（枠の外は透けない）。
      // テキストの形は、不透明な色で塗った文字の不透明度で透かす
      add('mask-image', `url("${svgDataUrl(maskImageSvg(scene, mask, m, node, { assets }))}")`)
      add('mask-mode', mask.maskType === 'luminance' ? 'luminance' : 'alpha')
      add('mask-size', '100% 100%')
      add('mask-repeat', 'no-repeat')
    }
  }

  return lines.join('\n')
}

/**
 * グラデーションの CSS。size はノードの枠。
 * ドキュメントの角度は 0° が左から右、90° が上から下。CSS は 0deg が下から上、90deg が左から右なので、90° ずれる。
 * CSS の linear-gradient は枠の中心を通り「枠の角がちょうど両端の色になる」線に色を並べる。直線の始点・終点がその線と違えば、
 * 始点・終点をその線に写した位置へ色の位置を移す（0% より前や 100% より後ろにもなる）。色が同じ線はどちらも向きに垂直なので、見た目は同じ
 */
function gradientCss(gradient: Gradient, style: CodeStyle, size: Size): string {
  const stopList = (offset: (value: number) => number) =>
    gradient.stops.map((stop) => `${paintCssColor(stop.color, gradient.opacity * stop.opacity, style, stop.variable)} ${percent(offset(stop.offset))}`)
  const stops = stopList((offset) => offset)
  if (gradient.type === 'conic') {
    // CSS の from は 0deg が真上。ドキュメントは 0° が右なので 90° ずれる
    return `conic-gradient(from ${num(cssDegrees(gradient.angle))}deg at ${percent(gradient.cx)} ${percent(gradient.cy)}, ${stops.join(', ')})`
  }
  if (gradient.type === 'radial') {
    // 楕円の大きさの % は、CSS も枠の幅・高さに対する割合。CSS は楕円を回せないので、横・縦が入れ替わる向き（90°・270°）だけ写し、
    // ほかの角度は回さない楕円で代える（パネルに知らせる）。焦点も CSS では持てないので、中心から始める（パネルに知らせる）
    const { cx, cy } = gradient
    const swap = Math.abs(((gradient.angle % 180) + 180) % 180 - 90) < 1e-9
    const rx = swap ? (gradient.ry * size.height) / (size.width || 1) : gradient.rx
    const ry = swap ? (gradient.rx * size.width) / (size.height || 1) : gradient.ry
    return `radial-gradient(${percent(rx)} ${percent(ry)} at ${percent(cx)} ${percent(cy)}, ${stops.join(', ')})`
  }
  const angle = linearAngle(gradient, size)
  const [start, end] = gradientLine(gradient, size)
  if (start.x === end.x && start.y === end.y) {
    // 始点と終点が重なると、色は最後の色だけになる（描画と同じ）
    const lastStop = gradient.stops[gradient.stops.length - 1]
    const last = paintCssColor(lastStop.color, gradient.opacity * lastStop.opacity, style, lastStop.variable)
    return `linear-gradient(${last}, ${last})`
  }
  const [from, to] = angleLine(angle, size)
  const lx = to.x - from.x
  const ly = to.y - from.y
  const length = lx * lx + ly * ly
  const along = (point: Point) => (length === 0 ? 0 : ((point.x - from.x) * lx + (point.y - from.y) * ly) / length)
  const t1 = along(start)
  const t2 = along(end)
  const css = cssDegrees(angle)
  return `linear-gradient(${num(css)}deg, ${stopList((offset) => t1 + offset * (t2 - t1)).join(', ')})`
}

/**
 * 切り抜きの拡大を表す object-view-box。画像のうち 1 / scale の大きさの範囲を positionX / positionY の割合の位置で切り出すと、
 * object-fit と object-position で枠に収めたとき、描画（paint.ts の imageRect）と同じ置き方になる
 */
function imageViewBox(node: ImageNode): string {
  const rest = 1 - 1 / node.scale
  const top = rest * node.positionY
  const left = rest * node.positionX
  return `inset(${[top, rest - left, rest - top, left].map(percent).join(' ')})`
}

/**
 * 塗りの色の CSS。塗りの不透明度が 1 未満なら、色の alpha にする。
 * 変数につないだ色は（style.variables があれば）var(--名前) にし、不透明度は color-mix で透明と混ぜて表す
 */
function paintCssColor(color: string, opacity: number, style: CodeStyle, variable?: VariableId): string {
  const name = variable === undefined || !style.variables ? undefined : variableCssName(style.variables, variable)
  if (name !== undefined) return opacity < 1 ? `color-mix(in srgb, var(${name}) ${num(opacity * 100)}%, transparent)` : `var(${name})`
  return formatColor(color, style.color, opacity < 1 ? { alpha: opacity } : {})
}

/** あれば、変数の CSS の名前 */
function variableCssName(collections: readonly VariableCollection[], id: VariableId): string | undefined {
  return variableIndex(collections).has(id) ? cssVariableName(collections, id) : undefined
}

/** 塗りの代表の色（単色ならその色、グラデーションなら始まりの色）の CSS。不透明度も含める */
function topColorCss(paint: Paint, style: CodeStyle): string {
  const variable = paint.type === 'solid' ? paint.variable : paint.stops[0].variable
  return paintCssColor(paintColor(paint), paint.opacity * (paint.type === 'solid' ? 1 : paint.stops[0].opacity), style, variable)
}

/** 角丸の値。4 隅が同じなら 1 つ、違えば左上・右上・右下・左下 */
function radiusText(radius: CornerRadius, format: (value: number) => string): string {
  return typeof radius === 'number' ? format(radius) : radius.map(format).join(' ')
}

/**
 * 塗りを CSS の background で表す。塗りがなければ null。
 * CSS は先に書いたものが手前で、色だけの層は一番下にしか置けないので、重ねる単色は同じ色のグラデーションにする
 */
function backgroundCss(fills: readonly Paint[], style: CodeStyle, size: Size): string | null {
  if (fills.length === 0) return null
  return fills
    .toReversed()
    .map((paint, i, all) => {
      if (paint.type !== 'solid') return gradientCss(paint, style, size)
      const color = paintCssColor(paint.color, paint.opacity, style, paint.variable)
      return i === all.length - 1 ? color : `linear-gradient(${color}, ${color})`
    })
    .join(', ')
}

/** 自動で並べるフレームの子か */
function inFlexParent(scene: Scene, id: NodeId): boolean {
  const parentId = scene.nodes[id].parentId
  const parent = parentId === null ? null : scene.nodes[parentId]
  return parent?.type === 'frame' && parent.layout !== null
}

/** 余白の値。4 辺が同じなら 1 つ、上下と左右がそれぞれ同じなら「上下 左右」、そうでなければ上・右・下・左 */
function paddingValues(layout: AutoLayout): number[] {
  const { paddingTop: top, paddingRight: right, paddingBottom: bottom, paddingLeft: left } = layout
  if (top === bottom && left === right) return top === left ? [top] : [top, right]
  return [top, right, bottom, left]
}

function paddingText(layout: AutoLayout): string {
  return paddingValues(layout).map(num).join(' ')
}

/** バリアントの名前を、プロパティごとの行にしたもの。バリアントの形の名前でなければ空 */
function variantRows(name: string): InspectRow[] {
  return (parseVariantName(name) ?? []).map(([key, value]) => ({ label: key, value }))
}

/** バリアントの元 main のインスタンスに出す行（まとまりの名前と、プロパティの値） */
function variantInstanceRows(page: Scene, main: SceneNode): InspectRow[] {
  const set = variantSetOf(page, main.id)
  return set ? [{ label: 'コンポーネント', value: set.name }, ...variantRows(main.name)] : []
}

/** 親の辺への追従の行。追従する子で、左・上（既定）でないときだけ */
function constraintRows(scene: Scene, node: SceneNode): InspectRow[] {
  const parent = node.parentId === null ? undefined : scene.nodes[node.parentId]
  const { horizontal, vertical } = node.constraints
  if (!followsConstraints(parent, node) || (horizontal === 'start' && vertical === 'start')) return []
  return [{ label: '親の辺に固定', value: `横 ${CONSTRAINT_LABELS.horizontal[horizontal]}・縦 ${CONSTRAINT_LABELS.vertical[vertical]}` }]
}

/** 大きさの下限・上限の行。決めていて、効く向きのものだけ */
function limitRows(scene: Scene, node: SceneNode): InspectRow[] {
  const limited = sizeLimited(scene, node)
  const rows: [string, number | null, 'width' | 'height'][] = [
    ['最小の幅', node.minWidth, 'width'],
    ['最大の幅', node.maxWidth, 'width'],
    ['最小の高さ', node.minHeight, 'height'],
    ['最大の高さ', node.maxHeight, 'height'],
  ]
  return rows.flatMap(([label, value, axis]) => (value !== null && limited[axis] ? [{ label, value: num(value) }] : []))
}

function paddingCss(layout: AutoLayout, px: (value: number) => string): string | null {
  const values = paddingValues(layout)
  return values.every((value) => value === 0) ? null : values.map(px).join(' ')
}

/** テキスト・画像の裏返しの CSS の scale の値。裏返していなければ null */
function flipOf(node: SceneNode): { x: 1 | -1; y: 1 | -1 } | null {
  if ((node.type !== 'text' && node.type !== 'image') || (!node.flipX && !node.flipY)) return null
  return { x: node.flipX ? -1 : 1, y: node.flipY ? -1 : 1 }
}

/** 親から配られた不透明度。親が子に不透明度を配る通過のフレームなら、その不透明度（親も配られていれば掛ける） */
function inheritedFade(scene: Scene, node: SceneNode): number {
  const parent = node.parentId === null ? undefined : scene.nodes[node.parentId]
  if (!parent) return 1
  const fade = passThroughFade(scene, parent)
  return fade === null ? 1 : fade * inheritedFade(scene, parent)
}

/** CSS の box-shadow の値。内側の影は inset を付け、広がりは 0 でなければ書く */
export function shadowCss(shadow: Shadow, style: CodeStyle = DEFAULT_CODE_STYLE): string {
  // 影の色はいつも濃さ（alpha）を付けて書く。変数につないだ色は var(--名前)（濃さは color-mix）
  const named = shadow.variable !== undefined && style.variables !== undefined && variableCssName(style.variables, shadow.variable) !== undefined
  const color = named ? paintCssColor(shadow.color, shadow.opacity, style, shadow.variable) : formatColor(shadow.color, style.color, { alpha: shadow.opacity })
  const inset = shadow.type === 'inner-shadow' ? 'inset ' : ''
  const spread = shadow.spread !== 0 ? ` ${length(shadow.spread, style)}` : ''
  return `${inset}${length(shadow.x, style)} ${length(shadow.y, style)} ${length(shadow.blur, style)}${spread} ${color}`
}

/** 円形のグラデーションを CSS で同じ形に書けるか（回さないか、横・縦が入れ替わるだけの向き） */
function radialCssExact(paint: RadialGradient): boolean {
  const turn = ((paint.angle % 90) + 90) % 90
  return turn < 1e-9 || 90 - turn < 1e-9
}

/** rem は、基準が 16px なら 1px = 0.0625rem なので、小数 4 桁まで出す */
function length(value: number, style: Pick<CodeStyle, 'unit' | 'remBase'>): string {
  if (value === 0) return '0'
  return style.unit === 'rem' ? `${Math.round((value / style.remBase) * 10000) / 10000}rem` : `${num(value)}px`
}

/**
 * いくつも選んでいるときの一覧: 全体を囲む矩形と、2 つなら、その間隔（1 つめから 2 つめまで）。
 * 間隔は、キャンバスに引く線と同じもの（measureCorners）。2 つが同じ向きに回っていれば、その向きの横・縦で測る。
 */
export function inspectSelection(scene: Scene, ids: readonly NodeId[]): InspectSection[] {
  const bounds = getNodesBounds(scene, ids)
  if (!bounds) return []
  const sections: InspectSection[] = [
    {
      title: '全体',
      rows: [
        { label: 'X', value: num(bounds.x) },
        { label: 'Y', value: num(bounds.y) },
        { label: '幅', value: num(bounds.width) },
        { label: '高さ', value: num(bounds.height) },
      ],
    },
  ]
  if (ids.length === 2) {
    const { angle, distances, outlines } = measureCorners(getCorners(scene, ids[0]), getCorners(scene, ids[1]))
    const horizontal = distances.filter((distance) => distance.axis === 'x')
    const vertical = distances.filter((distance) => distance.axis === 'y')
    // 重なっていれば、同じ向きに 2 本（左右の辺どうし、上下の辺どうし）出る
    const rows = (list: Distance[], label: string, sides: [string, string]) =>
      list.map((distance, index) => ({
        label: list.length === 2 ? `${label}（${sides[index]}）` : label,
        value: num(distance.distance),
      }))
    const all = [...rows(horizontal, '横', ['左', '右']), ...rows(vertical, '縦', ['上', '下'])]
    // どの向きで測ったのかを書き添える
    const basis: InspectRow | null =
      angle !== 0
        ? { label: '測る向き', value: `辺に沿う（${num(angle)}°）` }
        : outlines.length > 0
          ? { label: '測る向き', value: '回した図形は囲む矩形で' }
          : null
    sections.push({
      title: '間隔',
      rows: [...(all.length > 0 ? all : [{ label: '横・縦', value: '0' }]), ...(basis ? [basis] : [])],
    })
  }
  return sections
}

/** SVG を CSS の url() に入れる data URL にする。読めるように、URL で意味を持つ文字だけを % にし、二重引用符は一重に替える */
function svgDataUrl(svg: string): string {
  return `data:image/svg+xml,${svg.replace(/"/g, "'").replace(/[%#<>{}\n\r]/g, (c) => encodeURIComponent(c))}`
}

/** グラデーションの角度を CSS の角度（90° ずらす）に直し、0〜360 に収める */
function cssDegrees(deg: number): number {
  return (((deg + 90) % 360) + 360) % 360
}

/**
 * テキストと背景のコントラスト比（contrast.ts）。文字と背景は合成した後の色。グラデーションの上などで組がいくつもあるときは、
 * いちばん低い比の組を出し、基準もそれで判定する
 */
function contrastRows(scene: Scene, id: NodeId, hex: (color: string) => string): InspectRow[] {
  const result = textContrast(scene, id)
  if (result === null) return []
  if (result.kind === 'unknown') return [{ label: '比', value: `求められない（${result.reason}）` }]
  const { lowest, highest, large } = result
  const level = (ok: boolean, need: number) => `${ok ? '満たす' : '満たさない'}（${need}:1 以上）`
  return [
    { label: '文字', value: hex(lowest.text), color: lowest.text },
    { label: '背景', value: result.overWhite ? `${hex(lowest.background)}（後ろが透けている所は白の地として）` : hex(lowest.background), color: lowest.background },
    { label: '比', value: result.varies ? `いちばん低い所で ${formatRatio(lowest.ratio)}（高い所で ${formatRatio(highest.ratio)}）` : formatRatio(lowest.ratio) },
    { label: '文字の大きさ', value: large ? '大きな文字（24px 以上か、太字で 18.66px 以上）' : 'ふつうの文字' },
    { label: 'AA', value: level(result.aa, large ? CONTRAST_AA_LARGE : CONTRAST_AA) },
    { label: 'AAA', value: level(result.aaa, large ? CONTRAST_AAA_LARGE : CONTRAST_AAA) },
    result.varies && { label: '求め方', value: 'グラデーションは、止めの間も含めた全体の色のうち、いちばん低い比で判定している' },
  ].filter((row) => row !== false)
}

/** 実装側の部品の名前と import の場所（「Button（@/ui）」。既定の export なら書き添える） */
function codeText(code: CodeComponent): string {
  if (code.from === '') return code.name
  return `${code.name}（${code.from}${code.defaultExport ? '・既定の export' : ''}）`
}

function codeRow(code: CodeComponent | null) {
  return code !== null && { label: '実装の部品', value: codeText(code) }
}

/** 変数を、そのコレクションのどのモードで解決しても、その項目に入れられる値になるか（別名の先の別のコレクションは最初のモードで見る） */
function acceptedInEveryMode(collections: readonly VariableCollection[], id: VariableId, key: BindingKey): boolean {
  const index = variableIndex(collections)
  const entry = index.get(id)
  if (!entry) return false
  return entry.collection.modes.every((mode) =>
    acceptsBinding(key, resolveVariable(index, id, (other) => (other.id === entry.collection.id ? mode.id : other.modes[0].id))),
  )
}

/** レイアウトグリッド 1 つの説明（「カラム 12・溝 20・余白 20」「方眼 8」） */
export function layoutGridText(grid: LayoutGrid): string {
  if (grid.type === 'grid') return `方眼 ${num(grid.size)}`
  return `${grid.type === 'columns' ? 'カラム' : '行'} ${grid.count}・溝 ${num(grid.gutter)}・余白 ${num(grid.margin)}`
}
