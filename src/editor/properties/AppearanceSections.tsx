import { useState } from 'react'
import { isInstance } from '../../document/component.ts'
import { IMAGE_MIME_TYPES } from '../../document/kdr.ts'
import { cornerRadii } from '../../document/paint.ts'
import { OpenFileButton } from '../../ui/OpenFile.tsx'
import { CAP_LABELS, FIT_LABELS, optionsOf } from '../../ui/labels.ts'
import { setCornerRadius } from '../operations/paints.ts'
import { type PanelContext, linesIn, shapesIn, textsIn, MIXED, common, mapValue } from './context.ts'
import { CheckField, NumberField, Section, SelectField } from './fields.tsx'
import { EffectListSection, PaintListSection } from './PaintSections.tsx'
import { PathSection } from './PathSection.tsx'
import { isMarkerCap } from '../../document/path.ts'

const CORNERS = ['左上', '右上', '右下', '左下'] as const

type Props = {
  ctx: PanelContext
  /** 選んでいる画像を、選んだファイルの画像に差し替える */
  onReplaceImage: (file: File) => void
}

/** 塗り・画像・線・端の形・パス・角丸・影 */
export function AppearanceSections({ ctx, onReplaceImage }: Props) {
  const { store, selection, nodes, apply, inner, hasInstance, overridden } = ctx
  // インスタンスとその中身（写し）の見た目は元に合わせて作り直されるので、変えられるのは上書きできる項目
  // （塗り・線。文言はキャンバスで、表示はレイヤー一覧で変える）だけ
  const limited = hasInstance || inner
  const plain = inner ? [] : nodes.filter((node) => !isInstance(node))
  const shapes = shapesIn(nodes)
  const texts = textsIn(nodes)
  const lines = linesIn(nodes)
  const paths = nodes.filter((node) => node.type === 'path')
  const images = nodes.filter((node) => node.type === 'image')
  // 端の形を付けられるもの。閉じたパスには端がない
  const capped = paths.filter((node) => !node.closed)
  const rounded = plain.filter((node) => node.type === 'rect' || node.type === 'frame' || node.type === 'image')
  const filled = [...shapes, ...texts]
  const stroked = [...shapes, ...lines]
  const onlyShapes = shapes.length === nodes.length
  const radii = rounded.map((node) => cornerRadii(node.cornerRadius))
  const separate = rounded.some((node) => typeof node.cornerRadius !== 'number')
  const [cornersOpen, setCornersOpen] = useState(false)
  const fits = common(images.map((node) => node.fit))

  return (
    <>
      {filled.length === nodes.length && (
        <PaintListSection
          store={store}
          selection={selection}
          nodes={filled}
          paintKey="fills"
          title="塗り"
          fallback="#d9d9d9"
          // テキストは塗りを消せない
          required={texts.length > 0}
          overridden={overridden.has('fills')}
        />
      )}

      {images.length === nodes.length && (
        <Section title="画像" overridden={overridden.has('assetId')}>
          {!inner && (
            <SelectField
              label="収め方"
              value={common(images.map((node) => node.fit))}
              options={optionsOf(FIT_LABELS)}
              onChange={(fit) => apply({ fit })}
            />
          )}
          {!inner && fits !== 'stretch' && (
            <div className="field-grid">
              <NumberField
                label="横の位置 %"
                value={mapValue(common(images.map((node) => node.positionX)), (v) => Math.round(v * 1000) / 10)}
                min={0}
                max={100}
                onCommit={(percent) => apply({ positionX: percent / 100 })}
              />
              <NumberField
                label="縦の位置 %"
                value={mapValue(common(images.map((node) => node.positionY)), (v) => Math.round(v * 1000) / 10)}
                min={0}
                max={100}
                onCommit={(percent) => apply({ positionY: percent / 100 })}
              />
            </div>
          )}
          <OpenFileButton accept={IMAGE_MIME_TYPES.join(',')} onFiles={(files) => onReplaceImage(files[0])}>
            画像を差し替え
          </OpenFileButton>
        </Section>
      )}

      {stroked.length === nodes.length && (
        <PaintListSection
          store={store}
          selection={selection}
          nodes={stroked}
          paintKey="strokes"
          title="線"
          fallback="#000000"
          // 直線は線を消せない
          required={lines.length > 0}
          overridden={overridden.has('strokes')}
        >
          {!limited && (
            <NumberField
              label="太さ"
              value={common(stroked.map((n) => n.strokeWidth))}
              min={0}
              onCommit={(strokeWidth) => apply({ strokeWidth })}
            />
          )}
        </PaintListSection>
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
          {capped.some((node) => isMarkerCap(node.startCap) || isMarkerCap(node.endCap)) && (
            <NumberField
              label="印の大きさ"
              // 0 は線の太さから決める（空欄で「自動」）
              value={mapValue(common(capped.map((n) => n.capSize)), (size) => (size === 0 ? null : size))}
              emptyLabel="自動"
              min={0}
              onCommit={(capSize) => apply({ capSize })}
              onClear={() => apply({ capSize: 0 })}
            />
          )}
        </Section>
      )}

      <PathSection ctx={ctx} />

      {rounded.length === nodes.length && (
        <Section title="角丸">
          <NumberField
            label="半径"
            value={separate ? MIXED : common(rounded.map((n) => n.cornerRadius as number))}
            min={0}
            onCommit={(radius) => store.apply((base) => setCornerRadius(base, selection, null, radius))}
          />
          <CheckField
            label="角ごとに変える"
            value={separate || cornersOpen}
            onChange={(checked) => {
              setCornersOpen(checked)
              // やめるときは、左上の値に揃える
              if (!checked && separate) store.apply((base) => setCornerRadius(base, selection, null, radii[0][0]))
            }}
          />
          {(separate || cornersOpen) && (
            <div className="corner-grid">
              {CORNERS.map((name, corner) => (
                <NumberField
                  key={name}
                  label={name}
                  value={common(radii.map((r) => r[corner]))}
                  min={0}
                  onCommit={(radius) => store.apply((base) => setCornerRadius(base, selection, corner, radius))}
                />
              ))}
            </div>
          )}
        </Section>
      )}

      {onlyShapes && !limited && <EffectListSection store={store} selection={selection} nodes={shapes} />}
    </>
  )
}
