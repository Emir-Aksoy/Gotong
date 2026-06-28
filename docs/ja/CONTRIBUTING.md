# AipeHub へのコントリビューション

<!-- doc-version: 1.0 -->
> **ドキュメントバージョン 1.0** · 日本語訳 · 最終更新 2026-06-27 · 権威ある原典：[English](../../CONTRIBUTING.md)。訳文と英語版に矛盾がある場合は、英語版が優先されます。

コントリビューションをご検討いただきありがとうございます。AipeHub は初期段階のプロジェクトであり、パッチ・バグレポート・設計フィードバック・ドキュメント改善を歓迎しています。**コードだけが貢献ではありません** —— ビデオ、チュートリアル、トーク、翻訳、コミュニティサポートも [`CONTRIBUTORS.md`](../../CONTRIBUTORS.md) に記録されており、[`LEARN.md`](../../LEARN.md) でキュレーション掲載の資格があります。詳細は [表彰システム](RECOGNITION-SYSTEM.md) を参照してください。

## 基本ルール

- **親切にしてください。** イシュートラッカーや PR でのやりとりは、自分が悪い日にシニアエンジニアに接してほしいように振る舞ってください。
- **小さな PR を。** 独立した変更は大型 PR より早くマージされます。機能を綺麗に分割できるなら、部分ごとに送ってください。
- **Hub はシンプルに保つ。** AipeHub の設計思想は、Hub がルーティング・永続化を行い、エージェントのロジックを持たないことです。LLM 呼び出し・エージェントループ・ビジネスロジックを Hub に追加するパッチはリダイレクトされます。
- **ワイヤープロトコルはバージョン管理されています。** プロトコルレベルのメッセージ形状を変更するものはすべて `docs/PROTOCOL.md` とプロトコルバージョンのバンプを経由します。ローカルのみの変更はその限りではありません。
- **依存関係を勝手に追加しない。** ランタイム依存（特にネイティブ）の追加は重大な決断です — まずイシューを立ててください。

## ワークフロー

```bash
# GitHub でフォークした後:
git clone git@github.com:<you>/AipeHub.git
cd AipeHub
pnpm install
pnpm build

# 変更を加えたら…

pnpm -r typecheck      # 19 以上のパッケージすべてが型チェックを通過
pnpm -r test           # パッケージ全体で vitest を実行
pnpm test:python       # python-sdk の pytest
```

規約:

- TypeScript のストリクトモード、相対インポートには `.js` 拡張子付きの ESM（TypeScript の "node16/nodenext" 解決方式が必要）。
- テストはカバーするコードの隣に置く（`packages/*/tests/`）。
- リントはまだツールで強制されていません。既存ファイルのスタイルに合わせてください。
- コミットメッセージ: 命令形（"add foo"、"added foo" は不可）。非自明なコミットには段落を書いても構いません。

## リポジトリ構成

```
packages/
  core/           Hub + registry + scheduler + transcript + Space
  protocol/       Wire-protocol types (zero runtime)
  transport-ws/   Hub-side WebSocket adapter
  sdk-node/       Node SDK for remote agents (connect + AgentParticipant)
  web/            Embeddable web server + static SPA
  host/           Production binary (env-driven, no demo state)
  llm/            LlmAgent base class + LlmProvider interface
  llm-anthropic/  Anthropic provider
  llm-openai/     OpenAI provider
python-sdk/       Python SDK (mirror of sdk-node)
examples/         Runnable demos
docs/             Long-form architecture / protocol / deploy docs
```

## 着手しやすい領域

低コンテキストでスタートできるタスクをお探しなら、`good-first-issue` ラベルが付いたイシューを確認してください。常に歓迎されるテーマ:

- **ドキュメント**: タイポ、わかりやすい例、翻訳（プロジェクトには中国語話者のメンテナがいます。英語のみのドキュメントはまだ薄いです）。
- **テストカバレッジ**: 特にスケジューラのエッジケースや Space のオンディスクマイグレーションパス。
- **追加 LLM プロバイダ**: `packages/llm-anthropic` の形を参考にしてください。
- **管理 UI の A11y / i18n**: バニラ JS、フレームワークなし、小さなサーフェス。

## テンプレートのコントリビューション

TypeScript を書かなくてもコントリビューションできます。AipeHub は**テンプレート**を配布しています — 誰かがインポートすると動く hub が得られる自己完結型の YAML（エージェント・ワークフロー・ナレッジベースへの参照を含み、シークレットやナレッジコンテンツは含みません）。

- 単一の改変済みプロンプト → [`templates/community/`](../../templates/community/).
- インポート可能な hub 全体（マルチエージェント + ワークフロー）→
  [`templates/community/templates/`](../../templates/community/templates/) — そこの README に 5 ステップのフローが書かれています: フラグシップの例をコピーし、適応させ、プロベナンス（`derivedFrom`）を宣言し、`pnpm check:templates` でローカル検証し、PR を開く。

*コミュニティテンプレートとしてマージされる*基準（ライセンスが明確、パース可能、リテラルなシークレットなし）は、*フラグシップとして収録される*基準（決定論的なデモ、ガバナンスの姿勢が明記、メンテナンスされている）より低いです。[`GOVERNANCE.md`](../../GOVERNANCE.md) を参照してください。

## 普及活動もカウントされます

AipeHub を人々に届ける仕事 —— ビデオを作る、トークをする、チュートリアルを書く、
ドキュメントを翻訳する、コミュニティで質問に答え続ける —— はここでコードと
**同等の認定**を受けます。

- **[`CONTRIBUTORS.md`](../../CONTRIBUTORS.md)** に追加してもらうには、通常の
  pull request を開いて行を追加してください（あなた自身のものでも他の人のものでも）。
  ビデオやトークなど**リーチ**貢献の場合は、PR の説明に成果物へのリンクを含めて
  ください。
- **[`LEARN.md`](../../LEARN.md) にキュレーション掲載**されるには、正しい
  セクション下にエントリーを追加する pull request を開いてください。基準は：
  現在の設計に正確、真に有用、完成済み、明確に帰属表示されていること。

詳細な仕組みは [表彰システムの支柱⑤](RECOGNITION-SYSTEM.md#pillar-5) を
参照してください。

## バグの報告

有用なバグレポートには以下が含まれます:

- 試したこと（完全なコマンドライン、完全な環境変数）
- 期待していたこと
- 起こったこと（エラー出力全体、バグがルーティング / 永続化に関係する場合は `transcript.jsonl` の抜粋）
- バージョン: `node --version`、`pnpm --version`、OS

ネットワーク形状のバグ（ワーカーの切断、エージェントがルーティングされない）には、`/api/state` スナップショットを含めてください — それが hub が何を起きていると思っているかの正式な情報源です。

## セキュリティ

セキュリティの問題は公開のイシュートラッカーには**属しません**。[`SECURITY.md`](../../SECURITY.md) を参照してください。

## ライセンス

コントリビューションすることで、あなたの作業はプロジェクトが使用する [MIT ライセンス](../../LICENSE) のもとで提供されることに同意したことになります。CLA はありません。
