# kadrokreo

<img src="docs/logo/kadrokreo-wordmark.svg" alt="kadrokreo" height="40">

既存のオンラインデザインツールに近いデザインツール。

![editor の画面](docs/captures/editor.png)

## コンセプト

- スタンドアローンのデザインツール
- 認証やユーザ管理はなく、機能は viewer と editor に分かれる
- コメント機能は存在しない
- データは手元から出ない: kdr ファイルはブラウザの中で読み書きし、サーバーへ送らない（editor の編集中の内容もブラウザの IndexedDB に保存する）。外部への通信もしない（Docker で配信するときは CSP で通信先を自分自身だけに絞っている）

<!-- 上と下は別のまとまり -->

- **viewer モード**（既定）: kdr ファイルを読み込んで閲覧する。図形の設定・CSS・間隔を確かめられる。編集や変更はできない
- **editor モード**: Docker でオプションを付けて起動した場合のみ。kdr ファイルに書き出しができる
- **kdr ファイル**の実体は、ドキュメントの JSON と画像のファイルを tar にまとめて gzip 圧縮した 1 つのファイル（tar.gz）
- **コマンドライン**でも扱える: kdr コマンドで kdr ファイルを作る・編集する・PNG / SVG に書き出すことができ、パイプで組み合わせられる（自動化向け）
- **実装への橋渡し**: viewer から HTML + CSS・React・Vue のコードや PNG / SVG を取り出せる（デザインを実装する人のための表示）

## Getting started

Docker のイメージを GitHub Container Registry で公開している。

```sh
docker pull ghcr.io/yosiopp/kadrokreo:latest

docker run --rm -p 8080:80 ghcr.io/yosiopp/kadrokreo            # viewer モード
docker run --rm -p 8080:80 ghcr.io/yosiopp/kadrokreo --editor   # editor モード
```

http://localhost:8080 を開く。

viewer で開くファイルが手元になければ、最初の画面の「サンプルを開く」を押す（タスク管理アプリのスマホ画面と、その部品のコンポーネント。viewer に入っているので、ファイルを用意しなくてよい）。
図形を押すと大きさ・色・CSS が、画面のフレームを選ぶと HTML + CSS・React・Vue のコードが出る（[viewer の使い方](docs/guide/viewer.md)）。
同じサンプルは [`docs/examples/sample.kdr`](docs/examples/sample.kdr) にもある。

kdr ファイルを調べたり組み立てたりする `kdr` コマンドも、同じイメージから使える。

```sh
docker run --rm -i -v "$PWD:/work" --user "$(id -u):$(id -g)" ghcr.io/yosiopp/kadrokreo kdr --help
```

タグは `latest`（最新のリリース）が既定。版を固定するなら `ghcr.io/yosiopp/kadrokreo:0.1.0`（`0.1` で 0.1 系の最新）、
main の最新の状態を試すなら `edge`。ソースからイメージをビルドする手順は [CONTRIBUTING.md](CONTRIBUTING.md#ソースからイメージをビルドする) にある。

AI エージェントから使うなら、`kdr docs` がエージェント向けのリファレンスを出す。skill（Claude Code のプラグイン）の入れ方と、
`AGENTS.md` / `CLAUDE.md` に貼る雛形は、ユーザーズガイドの「[AI エージェントから使う](docs/guide/cli.md#ai-エージェントから使う)」にある。

操作方法は [ユーザーズガイド](docs/guide/README.md)（[editor](docs/guide/editor.md)・[viewer](docs/guide/viewer.md)・[コマンドライン](docs/guide/cli.md)・[kdr ファイル](docs/guide/kdr-file.md)・[未対応](docs/guide/limitations.md)）にある。

## 開発する人へ

開発環境・確認（`npm run check`）・ディレクトリ構成・CI は [CONTRIBUTING.md](CONTRIBUTING.md) にある。

## ライセンス

MIT（[LICENSE](LICENSE)）。ロゴの書体 Red Hat Display（SIL Open Font License）は SVG のパスに変換して使っていて、書体のファイルは同梱していない。
