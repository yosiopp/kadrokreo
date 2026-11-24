import type { DesignDocument, EllipseNode, FrameNode, PathNode, RectNode, Scene, SceneNode, Style, TextNode } from './types.ts'

// テストで使うノードの組み立て。editor の側にあるノードの生成（nodes.ts）は、共通側や viewer のテストからは使えない

export const base = {
  name: 'Node',
  parentId: null,
  x: 0,
  y: 0,
  width: 100,
  height: 50,
  rotation: 0,
  visible: true,
  locked: false,
  opacity: 1,
  blendMode: 'normal' as const,
  sizing: { width: 'fixed', height: 'fixed' } as SceneNode['sizing'],
  layoutPositioning: 'auto' as const,
  constraints: { horizontal: 'start', vertical: 'start' } as SceneNode['constraints'],
  minWidth: null,
  maxWidth: null,
  minHeight: null,
  maxHeight: null,
  isMask: false,
  maskType: 'vector' as const,
}
export const paint: Style = { fills: [{ type: 'solid', color: '#ff0000', opacity: 1, visible: true, blendMode: 'normal' }], strokes: [], strokeWidth: 1, strokeDashes: [], strokeDashOffset: 0, strokeJoin: 'miter', effects: [] }

export const rect = (patch: Partial<RectNode> = {}): RectNode => ({
  ...base,
  ...paint,
  id: 'rect',
  type: 'rect',
  cornerRadius: 0,
  isMask: false,
  maskType: 'vector',
  ...patch,
})
export const ellipse = (patch: Partial<EllipseNode> = {}): EllipseNode => ({
  ...base,
  ...paint,
  id: 'ellipse',
  type: 'ellipse',
  isMask: false,
  maskType: 'vector',
  ...patch,
})
/** パス。既定は塗りのない、黒い線の開いた形。枠と頂点は pathFromPoints で作ったものを patch に渡す */
export const path = (patch: Partial<PathNode> = {}): PathNode => ({
  ...base,
  id: 'path',
  type: 'path',
  points: [{ x: 0, y: 0 }, { x: 1, y: 1 }],
  closed: false,
  fills: [],
  strokes: [{ type: 'solid', color: '#000000', opacity: 1, visible: true, blendMode: 'normal' }],
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
  ...patch,
})
export const frame = (patch: Partial<FrameNode> = {}): FrameNode => ({
  ...base,
  ...paint,
  id: 'frame',
  type: 'frame',
  children: [],
  clipContent: true,
  passThrough: false,
  cornerRadius: 0,
  layout: null,
  component: null,
  setDescription: '',
  booleanOperation: null,
  booleanIncludeStrokes: false,
  ...patch,
})
export const text = (patch: Partial<TextNode> = {}): TextNode => ({
  ...base,
  id: 'text',
  type: 'text',
  text: 'こんにちは',
  fontSize: 16,
  fontFamily: 'sans-serif',
  fills: [{ type: 'solid', color: '#111111', opacity: 1, visible: true, blendMode: 'normal' }],
  effects: [],
  sizing: { width: 'hug', height: 'hug' },
  fontWeight: 400,
  textAlign: 'left',
  lineHeight: 1.5,
  textPath: null,
  flipX: false,
  flipY: false,
  ...patch,
})

export function sceneOf(...nodes: SceneNode[]): Scene {
  return {
    nodes: Object.fromEntries(nodes.map((node) => [node.id, node])),
    rootIds: nodes.filter((node) => node.parentId === null).map((node) => node.id),
  }
}

export function docOf(scene: Scene): DesignDocument {
  return {
    name: 'x',
    pages: [{ id: 'p1', name: 'Page 1', ...scene }],
    assets: { a1: { mime: 'image/png', bytes: new Uint8Array() } },
    fonts: [],
  }
}
