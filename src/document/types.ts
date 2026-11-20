export type NodeId = string
export type AssetId = string
export type PageId = string

type BaseNode = {
  id: NodeId
  name: string
  /** null はページ直下 */
  parentId: NodeId | null
  /** 親の左上を原点とする座標。回転していても、回す前の枠の左上を指す */
  x: number
  y: number
  width: number
  height: number
  /** 枠の中心を軸にした時計回りの角度（度）。子も一緒に回る */
  rotation: number
  visible: boolean
  locked: boolean
  opacity: number
}

/** 落ち影。color は #rrggbb、濃さは opacity（0〜1）で持つ */
export type Shadow = {
  x: number
  y: number
  blur: number
  color: string
  opacity: number
}

/**
 * 直線状のグラデーション。angle は色が変わっていく向き（度）で、0 が左から右、90 が上から下。
 * stops は offset（0〜1）の小さい順に並べる。
 */
export type Gradient = {
  angle: number
  stops: { offset: number; color: string }[]
}

type Paint = {
  fill: string | null
  /** 指定があれば、fill の代わりにこのグラデーションで塗る */
  fillGradient: Gradient | null
  stroke: string | null
  strokeWidth: number
  shadow: Shadow | null
}

export type RectNode = BaseNode & Paint & { type: 'rect'; cornerRadius: number }

export type EllipseNode = BaseNode & Paint & { type: 'ellipse' }

/** 線の端の形 */
export type Cap = 'none' | 'arrow'

type Caps = { startCap: Cap; endCap: Cap }

/**
 * 枠の対角線として描く直線。down は左上と右下、up は左下と右上を結ぶ。
 * 始点は左側の端。flipped なら右側の端が始点になる。
 * 水平・垂直の線は高さ・幅が 0 になる。
 */
export type LineNode = BaseNode &
  Caps & {
    type: 'line'
    stroke: string
    strokeWidth: number
    direction: 'down' | 'up'
    flipped: boolean
  }

/**
 * 頂点を直線でつないだ折れ線や多角形。
 * 頂点は枠に対する割合（0〜1）で持つので、枠の大きさを変えれば形も一緒に伸縮する。
 */
export type PathNode = BaseNode &
  Paint &
  Caps & {
    type: 'path'
    points: { x: number; y: number }[]
    /** 最後の頂点と最初の頂点をつなぐ */
    closed: boolean
  }

export type TextNode = BaseNode & {
  type: 'text'
  text: string
  fontSize: number
  fontFamily: string
  fill: string
  /** true なら折り返さず、幅は中身に合わせる。false なら width で折り返す。高さはどちらも中身で決まる */
  autoWidth: boolean
  fontWeight: 400 | 700
  textAlign: 'left' | 'center' | 'right'
  /** 行の高さ。fontSize に対する倍率 */
  lineHeight: number
}

/**
 * fit は、枠と画像の縦横比が違うときの収め方。
 * cover は枠を埋めてはみ出した分を切り落とし、contain は全体が入るよう余白を空け、stretch は引き伸ばす。
 */
export type ImageNode = BaseNode & {
  type: 'image'
  assetId: AssetId
  cornerRadius: number
  fit: 'stretch' | 'cover' | 'contain'
}

/**
 * フレームの中身を自動で並べる設定。子は children の順に、direction の向きへ並ぶ。
 * 並べた結果の位置と大きさは各ノードの x / y / width / height にも入っているので、
 * 表示するだけなら、この設定を読まなくてよい。
 */
export type AutoLayout = {
  direction: 'horizontal' | 'vertical'
  /** 子と子の間隔 */
  gap: number
  /** 左右・上下の余白 */
  paddingX: number
  paddingY: number
  /** 並べる向きと直交する向きの揃え方 */
  align: 'start' | 'center' | 'end'
  /** 並べる向きの寄せ方。大きさが固定のときだけ意味がある */
  justify: 'start' | 'center' | 'end' | 'space-between'
  /** hug は中身に合わせる、fixed は width / height のまま */
  widthMode: 'hug' | 'fixed'
  heightMode: 'hug' | 'fixed'
}

export type FrameNode = BaseNode &
  Paint & {
    type: 'frame'
    /** 先頭が最背面。自動で並べるときは、先頭から順に並ぶ */
    children: NodeId[]
    clipContent: boolean
    cornerRadius: number
    layout: AutoLayout | null
  }

export type SceneNode =
  | RectNode
  | EllipseNode
  | LineNode
  | PathNode
  | TextNode
  | FrameNode
  | ImageNode

/** 埋め込みファイル。kdr は 1 つの JSON なので、中身は base64 で持つ */
export type Asset = { mime: string; data: string }

/** 1 ページ分のノードの木 */
export type Scene = {
  nodes: Record<NodeId, SceneNode>
  /** ページ直下のノード。先頭が最背面 */
  rootIds: NodeId[]
}

/** ページごとに独立したキャンバスを持つ。ノードの id はページの中で一意であればよい */
export type Page = Scene & { id: PageId; name: string }

export type DesignDocument = {
  name: string
  /** 必ず 1 ページ以上ある */
  pages: Page[]
  /** 全ページで共有する */
  assets: Record<AssetId, Asset>
}
