import type { Bounds } from '../document/geometry.ts'
import { solid } from '../document/paint.ts'
import type {
  AssetId,
  EllipseNode,
  FrameNode,
  ImageNode,
  NodeId,
  PathNode,
  RectNode,
  TextNode,
} from '../document/types.ts'

const ID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-'

// crypto.randomUUID は http 配信（非セキュアコンテキスト）では使えないので getRandomValues で作る
export function createId(): NodeId {
  let id = ''
  for (const byte of crypto.getRandomValues(new Uint8Array(12))) id += ID_ALPHABET[byte & 63]
  return id
}

function base(name: string, bounds: Bounds) {
  return {
    id: createId(),
    name,
    parentId: null,
    ...bounds,
    rotation: 0,
    visible: true,
    locked: false,
    opacity: 1,
    blendMode: 'normal' as const,
    sizing: { width: 'fixed', height: 'fixed' } as RectNode['sizing'],
    layoutPositioning: 'auto' as const,
    constraints: { horizontal: 'start', vertical: 'start' } as RectNode['constraints'],
    minWidth: null,
    maxWidth: null,
    minHeight: null,
    maxHeight: null,
    isMask: false,
    maskType: 'vector' as const,
  }
}

export function createRect(bounds: Bounds): RectNode {
  return {
    ...base('Rectangle', bounds),
    type: 'rect',
    fills: solid('#d9d9d9'),
    strokes: [],
    strokeWidth: 1,
    strokeDashes: [],
    strokeDashOffset: 0,
    strokeJoin: 'miter',
    effects: [],
    cornerRadius: 0,
    isMask: false,
    maskType: 'vector',
  }
}

export function createEllipse(bounds: Bounds): EllipseNode {
  return {
    ...base('Ellipse', bounds),
    type: 'ellipse',
    fills: solid('#d9d9d9'),
    strokes: [],
    strokeWidth: 1,
    strokeDashes: [],
    strokeDashOffset: 0,
    strokeJoin: 'miter',
    effects: [],
    isMask: false,
    maskType: 'vector',
  }
}

/**
 * 直線（2 つの頂点を持つ開いたパス）。points を省くと、枠の左上から右下へ引く。
 * shape は pathFromPoints で作った枠と頂点でもよい
 */
export function createLine(shape: Bounds & Partial<Pick<PathNode, 'points'>>): PathNode {
  const { points = [{ x: 0, y: 0 }, { x: 1, y: 1 }], ...bounds } = shape
  return { ...createPath({ ...bounds, points }, false), name: 'Line' }
}

/** shape は pathFromPoints で作った枠と頂点。閉じた形には塗りを付ける */
export function createPath(shape: Bounds & Pick<PathNode, 'points'>, closed: boolean): PathNode {
  return {
    ...base('Path', shape),
    type: 'path',
    points: shape.points,
    closed,
    fills: solid(closed ? '#d9d9d9' : null),
    strokes: solid('#000000'),
    strokeWidth: 1,
    strokeDashes: [],
    strokeDashOffset: 0,
    strokeJoin: 'miter',
    effects: [],
    startCap: 'none',
    endCap: 'none',
    capSize: 0,
    contours: [],
    fillRule: 'nonzero',
    isMask: false,
    maskType: 'vector',
  }
}

export function createText(bounds: Bounds, text = ''): TextNode {
  return {
    ...base('Text', bounds),
    type: 'text',
    text,
    fontSize: 16,
    fontFamily: 'sans-serif',
    fills: solid('#000000'),
    effects: [],
    sizing: { width: 'hug', height: 'hug' },
    fontWeight: 400,
    textAlign: 'left',
    lineHeight: 1.2,
    letterSpacing: 0,
    textDecoration: 'none',
    textPath: null,
    flipX: false,
    flipY: false,
  }
}

export function createImage(bounds: Bounds, assetId: AssetId): ImageNode {
  return { ...base('Image', bounds), type: 'image', assetId, effects: [], cornerRadius: 0, fit: 'cover', positionX: 0.5, positionY: 0.5, scale: 1, flipX: false, flipY: false }
}

export function createFrame(bounds: Bounds): FrameNode {
  return {
    ...base('Frame', bounds),
    type: 'frame',
    fills: solid('#ffffff'),
    strokes: [],
    strokeWidth: 1,
    strokeDashes: [],
    strokeDashOffset: 0,
    strokeJoin: 'miter',
    effects: [],
    children: [],
    clipContent: true,
    passThrough: false,
    cornerRadius: 0,
    layout: null,
    component: null,
    setDescription: '',
    booleanOperation: null,
    booleanIncludeStrokes: false,
  }
}
