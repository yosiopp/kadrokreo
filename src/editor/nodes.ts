import type { Bounds } from '../document/geometry.ts'
import type {
  AssetId,
  EllipseNode,
  FrameNode,
  ImageNode,
  LineNode,
  NodeId,
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
  }
}

export function createRect(bounds: Bounds): RectNode {
  return {
    ...base('Rectangle', bounds),
    type: 'rect',
    fill: '#d9d9d9',
    stroke: null,
    strokeWidth: 1,
    shadow: null,
    cornerRadius: 0,
  }
}

export function createEllipse(bounds: Bounds): EllipseNode {
  return {
    ...base('Ellipse', bounds),
    type: 'ellipse',
    fill: '#d9d9d9',
    stroke: null,
    strokeWidth: 1,
    shadow: null,
  }
}

export function createLine(bounds: Bounds, direction: LineNode['direction'] = 'down'): LineNode {
  return { ...base('Line', bounds), type: 'line', stroke: '#000000', strokeWidth: 1, direction }
}

export function createText(bounds: Bounds, text = ''): TextNode {
  return {
    ...base('Text', bounds),
    type: 'text',
    text,
    fontSize: 16,
    fontFamily: 'sans-serif',
    fill: '#000000',
    autoWidth: true,
    fontWeight: 400,
    textAlign: 'left',
    lineHeight: 1.2,
  }
}

export function createImage(bounds: Bounds, assetId: AssetId): ImageNode {
  return { ...base('Image', bounds), type: 'image', assetId, cornerRadius: 0 }
}

export function createFrame(bounds: Bounds): FrameNode {
  return {
    ...base('Frame', bounds),
    type: 'frame',
    fill: '#ffffff',
    stroke: null,
    strokeWidth: 1,
    shadow: null,
    children: [],
    clipContent: true,
    cornerRadius: 0,
  }
}
