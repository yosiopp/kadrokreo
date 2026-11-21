export type NodeId = string
export type AssetId = string
export type PageId = string

/**
 * 1 つの向きの大きさの決め方。fixed は width / height のまま、hug は中身に合わせる、fill は親いっぱいに伸ばす。
 * hug は自動で並べるフレーム（layout があるもの）とテキストの幅だけが持てる（テキストの高さは常に hug）。
 * fill は親が自動で並べるときだけ効き、そうでなければ fixed と同じ（親を移しても残る）
 */
export type Sizing = 'fixed' | 'hug' | 'fill'

/**
 * 親の大きさが変わったときの、1 つの向きの追従のしかた（既存のデザインツールの constraints に当たる）。
 * start は先頭の辺（左・上）からの距離を保ち、end は末尾の辺（右・下）からの距離を保ち、
 * stretch は両方の辺からの距離を保って伸縮し、center は親の中心からのずれを保ち、scale は親と同じ割合で位置と大きさを変える
 */
export type Constraint = 'start' | 'end' | 'stretch' | 'center' | 'scale'

type BaseNode = {
  id: NodeId
  name: string
  /** null はページ直下。kdr ファイルには書かない（入れ子から決まる） */
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
  /**
   * 向きごとの大きさの決め方。fill は、並べる向きなら余った場所を分け合い、直交する向きなら余白の内側いっぱいになる
   */
  sizing: { width: Sizing; height: Sizing }
  /**
   * 自動で並べるフレームの子のとき、並びに加わるか（auto）、並びから外れて x / y のまま置かれるか（absolute）。
   * 親が自動で並べないなら意味はない
   */
  layoutPositioning: 'auto' | 'absolute'
  /**
   * 親のフレームの大きさが変わったときの追従のしかた。親が自動で並べないフレームか、並びから外した（absolute）ときだけ効く。
   * ページ直下のものや、並びに加わっている子では意味はない
   */
  constraints: { horizontal: Constraint; vertical: Constraint }
  /**
   * 大きさの下限と上限（null は決めない）。大きさを自動で決める向きでだけ効く:
   * fill で伸ばしている向きと、hug で中身に合わせている向き（`sizeLimited`）
   */
  minWidth: number | null
  maxWidth: number | null
  minHeight: number | null
  maxHeight: number | null
}

/** グラデーションの色の位置。offset（0〜1）の小さい順に並べる */
export type ColorStop = { offset: number; color: string }

/**
 * 塗り（面・線・文字に使う）。色は #rrggbb。
 * linear は直線状のグラデーションで、angle は色が変わっていく向き（度）。0 が左から右、90 が上から下。
 * radial は円形（楕円）のグラデーションで、中心 cx / cy は枠の左上からの位置、半径 rx / ry は横・縦の半径で、
 * どれも枠の幅・高さに対する割合（SVG の objectBoundingBox、CSS の radial-gradient の % と同じ）。
 * 中心が最初の色、半径の楕円の上が最後の色で、その外は最後の色のまま。既定（枠に内接する楕円）は 0.5 が 4 つ。
 * 種類を足すとき（角度のグラデーションなど）は type を増やす
 */
export type Paint =
  | { type: 'solid'; color: string }
  | { type: 'linear'; angle: number; stops: ColorStop[] }
  | { type: 'radial'; cx: number; cy: number; rx: number; ry: number; stops: ColorStop[] }

export type LinearGradient = Extract<Paint, { type: 'linear' }>
export type RadialGradient = Extract<Paint, { type: 'radial' }>
/** 色の位置を持つ塗り（グラデーション） */
export type Gradient = LinearGradient | RadialGradient

/** 落ち影などの効果。color は #rrggbb、濃さは opacity（0〜1）で持つ。種類を足すとき（内側の影など）は type を増やす */
export type Effect = {
  type: 'drop-shadow'
  x: number
  y: number
  blur: number
  color: string
  opacity: number
}

/**
 * 図形の見た目。fills は下から順に重ねて塗る（先頭が一番下）。strokes も同じで、太さは strokeWidth の 1 つだけ。
 * effects も先頭から順にかける。どれも空の配列なら、その見た目はない
 */
export type Style = {
  fills: Paint[]
  strokes: Paint[]
  strokeWidth: number
  effects: Effect[]
}

/**
 * 角丸の半径。数値なら 4 隅とも同じ。配列なら左上・右上・右下・左下の順（CSS の border-radius と同じ）。
 * 4 隅が同じ値なら数値で持つ（editor の操作がそう揃える。読み込みは配列のままでも受け付ける）
 */
export type CornerRadius = number | [number, number, number, number]

export type RectNode = BaseNode & Style & { type: 'rect'; cornerRadius: CornerRadius }

export type EllipseNode = BaseNode & Style & { type: 'ellipse' }

/**
 * 線の端の形。round / square は線の太さで決まる端（CSS・SVG の stroke-linecap と同じ形で、線の太さの半分だけ端の外へ出る）。
 * arrow / circle / diamond は端に付ける印で、大きさは capSize。矢印は先が端に来るよう線を短くし、丸とひし形は端を中心に置く
 */
export type Cap = 'none' | 'round' | 'square' | 'arrow' | 'circle' | 'diamond'

/**
 * パスの頂点。枠に対する割合（0〜1）で持つので、枠の大きさを変えれば形も一緒に伸縮する。
 * in / out は 3 次ベジェ曲線の制御点で、頂点からのずれ（同じく枠に対する割合）。in は前の頂点から来る辺、out は次の頂点へ向かう辺に効く。
 * 辺の両端の制御点がどちらもなければ、その辺は直線。片方だけなら、ないほうは頂点そのものを制御点とみなす（SVG の C と同じ）。
 * 枠は曲線そのものを囲む矩形なので、制御点は 0〜1 の外に出ることがある。
 * 省略できる項目で、kdr ファイルでもメモリ上でも、ないときは書かない（角の頂点）。
 * radius は角の丸めの半径（px。割合ではないので、枠の大きさを変えても丸めの大きさは変わらない）。0 より大きいときだけ書く。
 * 効くのは制御点を持たない頂点で、両側の辺が直線のときだけ（開いたパスの両端には効かない）。両側の辺の半分の長さまでに抑えて描く
 */
export type PathPoint = {
  x: number
  y: number
  in?: { x: number; y: number }
  out?: { x: number; y: number }
  radius?: number
}

/**
 * 頂点を直線か 3 次ベジェ曲線でつないだ線や形。直線も 2 つの頂点を持つ開いたパスで表す（`isLine`）。
 * 頂点の順に引くので、最初の頂点が始点、最後の頂点が終点。水平・垂直の直線は高さ・幅が 0 になる。
 */
export type PathNode = BaseNode &
  Style & {
    type: 'path'
    points: PathPoint[]
    /** 最後の頂点と最初の頂点をつなぐ */
    closed: boolean
    startCap: Cap
    endCap: Cap
    /** 端の印（矢印・丸・ひし形）の大きさ（px、矢印なら長さ）。0 なら線の太さから決める（太さの 4 倍、最小 10） */
    capSize: number
  }

export type TextNode = BaseNode & {
  type: 'text'
  text: string
  fontSize: number
  fontFamily: string
  /** 文字の塗り。先頭が一番下 */
  fills: Paint[]
  /** 100〜900 の 100 刻み（CSS の font-weight と同じ） */
  fontWeight: number
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
  cornerRadius: CornerRadius
  fit: 'stretch' | 'cover' | 'contain'
  /**
   * 画像を枠のどこに寄せるか（0〜1。CSS の object-position の % と同じ）。0 は左（上）端、1 は右（下）端、0.5 は中央。
   * cover では切り抜く位置（はみ出した分のどこを残すか）、contain では余白の配り方になる。stretch では意味はない
   */
  positionX: number
  positionY: number
}

/**
 * フレームの中身を自動で並べる設定。子は children の順に、direction の向きへ並ぶ。
 * 並べた結果の位置と大きさは各ノードの x / y / width / height にも入っているので、
 * 表示するだけなら、この設定を読まなくてよい。フレーム自身の大きさの決め方は sizing にある。
 */
export type AutoLayout = {
  direction: 'horizontal' | 'vertical'
  /** 子と子の間隔 */
  gap: number
  /** 内側の余白 */
  paddingTop: number
  paddingRight: number
  paddingBottom: number
  paddingLeft: number
  /** 並べる向きと直交する向きの揃え方 */
  align: 'start' | 'center' | 'end'
  /** 並べる向きの寄せ方。並べる向きの大きさが中身に合わせる（hug）でないときだけ意味がある */
  justify: 'start' | 'center' | 'end' | 'space-between'
  /**
   * 並べる向きに収まらない子を、次の行（縦に並べるなら次の列）へ折り返すか。
   * 並べる向きの大きさが中身に合わせる（hug）なら折り返さない
   */
  wrap: boolean
  /** 折り返したときの、行と行の間隔 */
  crossGap: number
  /**
   * 折り返したときの、行のまとまりの置き方（CSS の align-content）。auto は align に従って寄せ、
   * space-between は直交する向きの余りを行の間に均等に配る。折り返さないなら意味はない
   */
  alignContent: 'auto' | 'space-between'
}

/**
 * コンポーネントとのつながり。main は部品の元になるフレームで、instance はそれを配置したもの。
 * instance の中身（子孫と見た目）は main の写しで、main を変えると作り直される。
 * 写しは普通のノードとしてページに入っているので、表示するだけなら、このつながりを読まなくてよい。
 */
export type ComponentLink =
  /** id はドキュメントの中で一意。main と、その instance が同じ値を持つ */
  | {
      id: string
      role: 'main'
      /** コンポーネントの説明文（使い方など）。空ならなし */
      description: string
      /** コンポーネントのプロパティ。名前は main の中で一意 */
      properties: ComponentProperty[]
    }
  | {
      id: string
      role: 'instance'
      /**
       * このインスタンスだけの上書き。キーは main の側のノードの id（main 自身の id なら、インスタンスの根への上書き）。
       * 上書きした結果も写しに入っているので、表示するだけなら読まなくてよい。
       */
      overrides: Record<NodeId, Override>
    }

/**
 * コンポーネントのプロパティ（既存のデザインツールのコンポーネントプロパティ）。main の中のノードに結び、インスタンスごとに値を選べる。
 * インスタンスでの値は、結んだノードへの上書き（Override）そのもので、別には持たない。既定値は main での値。
 * バリアントのプロパティは名前（`プロパティ=値`）で表すので、ここには入れない。
 */
export type ComponentProperty = {
  name: string
  /**
   * text: 結んだテキストの文言（上書きの text）、boolean: 結んだノードの表示（上書きの visible）、
   * instance: 結んだ入れ子のインスタンスの元（上書きの componentId）。種類の合わないノードは無視する
   */
  type: 'text' | 'boolean' | 'instance'
  /** 結んだノード。main の中のノード（上書きのキーと同じ、main の側の id）。main の外や、ないノードは無視する */
  targets: NodeId[]
}

/**
 * main の値の代わりに使う値。指定した項目だけが変わる。
 * そのノードが持たない項目は無視する。
 */
export type Override = {
  text?: string
  fills?: Paint[]
  strokes?: Paint[]
  visible?: boolean
  /** テキストの書式。大きさは、写しを作り直すときに測り直す */
  fontSize?: number
  fontFamily?: string
  fontWeight?: number
  /** 画像の差し替え。ドキュメントの assets にあるもの */
  assetId?: AssetId
  /**
   * 入れ子のインスタンスの差し替え。キーのノードが main の中に置いたインスタンスのとき、
   * そこをこの id のコンポーネントのインスタンスにする。そのほかのノードや、元が見つからない・循環するときは無視する
   */
  componentId?: string
}

export type FrameNode = BaseNode &
  Style & {
    type: 'frame'
    /** 先頭が最背面。自動で並べるときは、先頭から順に並ぶ */
    children: NodeId[]
    clipContent: boolean
    cornerRadius: CornerRadius
    layout: AutoLayout | null
    component: ComponentLink | null
  }

export type SceneNode =
  | RectNode
  | EllipseNode
  | PathNode
  | TextNode
  | FrameNode
  | ImageNode

/**
 * 埋め込みファイル（画像の元のファイルそのもの）。id は中身の SHA-256（document/sha256.ts）。
 * kdr では tar の assets/<id>.<拡張子> に入る。メモリ上も自動保存（IndexedDB）でもバイト列のまま持つ（base64 にしない）
 */
export type Asset = { mime: string; bytes: Uint8Array<ArrayBuffer> }

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
