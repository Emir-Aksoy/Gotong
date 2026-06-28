# AipeHub

<!-- doc-version: 1.0 -->
> **ドキュメントバージョン 1.0** · 日本語訳 · 最終更新 2026-06-27 · 権威ある原典：[English](../../README.md)。訳文と英語版に矛盾がある場合は、英語版が優先されます。

[English](../../README.md) · [中文文档](../../docs/zh/README.md)

**AI + 人 + Hub** — 人と AI エージェントが同等の参加者として協力し、組織がキー・データ・課金を手放すことなくフェデレートするセルフホスト型基盤。

AipeHub はエージェントではなく、別のエージェントフレームワークでもありません。それは**それらの下にある層**です：レジストリ、メッセージバス、タスクルーター、ガバナンスされたフェデレーションリンク、追記専用トランスクリプト。LangGraph / CrewAI エージェント、CLI コーディングエージェント（Claude Code、Codex）、そして人間がすべて同じ `Participant` として接続されます。Hub はシグナルの流れを維持し境界を強制します——LLM を実行しないため、すべての決定は参加者に留まります。

### 重要なことを実際に任せられる AI

ほとんどの AI ツールは 2 つの選択肢を提供します：コントロールできないクラウドにすべてを委ねるか、自分ですべてをつなぎ合わせるか。AipeHub は 3 つ目の選択肢です——**境界が本物で、あなたのものであるため、家庭・家族・お金に向けられる AI：**

- **重要な場所では人間がループに入ります。** 可逆的なアクション（電気を消す）はそのまま実行されます。不可逆的なもの（ドアに鍵をかける、お金を使う、子どものデータをリンク越しに送る）は、人間がインボックスで確認するまで待ちます。ワークフローはゲートをスキップできません。
- **キーとデータはディスク上に留まります。** 認証情報はあなた自身の `.aipehub/` ディレクトリに暗号化されています。別の Hub とフェデレートすることで共有されるのは機能であり、ボルトではありません。
- **暗闇で判断するものはありません。** すべてのディスパッチと結果は読むことができる追記専用トランスクリプトです。フレームワークはモデルを実行しないため、隠れた判断は存在しません。

→ 今日から非技術者がインポートして実行できる Hub の **[フラッグシップテンプレート](../../docs/zh/FLAGSHIP-TEMPLATES.md)** を参照してください（スマートホーム、カフェ運営、家庭学習 Hub、個人コーディング Hub）。各テンプレートにはガバナンスゲートが明確に示され、ワンコマンドデモが付いています。自分のものを共有したいですか？[`templates/community/templates/`](../../templates/community/templates/)。

## コアのアイデア

- **Hub は意図的に単純です。** LLM を実行せず、エージェントループを所有しません。メッセージをルーティングし、タスクをディスパッチし、トランスクリプトを永続化し、イベントを発行します。決定は参加者に留まります。
- **人間はファーストクラスです。** 人間はエージェントと同様に `Participant` です。Hub の非同期・長時間実行プリミティブは両方に適用されます。
- **一つのインターフェース、二つのデプロイ形態。** エージェントは、プロセス内で実行されるかネットワーク越しに実行されるかに関わらず、同じ `Participant` コントラクトを実装します。ローカルエージェントとリモートエージェントは同じレジストリと同じスケジューラーを共有します。
- **プラグ可能なスケジューリング。** 標準で 3 つのタスクルーティング戦略：明示的割り当て、機能マッチング、ブロードキャスト申告。
- **LLM は持ち込みです。** 小さな `LlmAgent` 基底クラスと中立的な `LlmProvider` インターフェースにより、Hub に触れることなく Claude、GPT、またはその他のモデルでエージェントを動かすことができます。

## ステータス

**セルフホスト、ファイルファースト、マルチ組織使用のためのガバナンス。** ワークスペースはディスク上のディレクトリ（`.aipehub/`）です——ディレクトリを削除すればスペースが消え、コピーすればチームメンバーに部屋を手渡したことになり、再起動は透明です。その上に：組織ごとの認証情報ボルト、リンクごとの信頼契約を持つクロス組織フェデレーション（機能アローリスト・データクラスゲート・クォータ・失効）、Human-in-the-loop 承認インボックス、使用量/コスト台帳。Hub は引き続き LLM を実行しません——すべての決定は参加者に留まります。

npm パッケージは `@aipehub/*` でスコープされています。Python SDK は PyPI の `aipehub` です。ライセンス：[MIT](../../LICENSE)。

## あなたの入口を選ぶ

> **迷った？** [`docs/OVERVIEW.md`](../../docs/OVERVIEW.md) から始めてください——使用法、ライセンス、エージェントオンボーディング、テンプレートダウンロード、マルチユーザーチーム、マルチチームフェデレーションを一つのナラティブにまとめた 1 ページです。下の表はロール別の詳細です。

| あなたは… | これを読む | TL;DR |
|---|---|---|
| 🧭 **初めてここに来た** | [`docs/OVERVIEW.md`](../../docs/OVERVIEW.md) | すべての概念の 5 分マップ + 「小規模チームワークフロー」ウォークスルー。 |
| 🧑 **部屋に参加するワーカー/管理者** | [`docs/HUMAN.md`](../../docs/HUMAN.md) | オペレーターが提供した URL を開き、ニックネームを選べば完了。 |
| 🤖 **接続するエージェントを書いている** | [`docs/AGENT.md`](../../docs/AGENT.md) | `@aipehub/sdk-node` または Python `aipehub`。`AgentParticipant` をサブクラス化。 |
| 🧩 **コードを書かずに LLM エージェントを導入する** | [`docs/TEMPLATES.md`](../../docs/TEMPLATES.md) + [`templates/`](../../templates/) | YAML マニフェスト → 管理 UI でペースト/アップロード → ホストが生成。2 セット：プロジェクトオリジナル（`templates/agents/`）と CC0/MIT コミュニティ適応（`templates/community/`）。 |
| ⭐ **役に立つ Hub がすぐほしい** | [`docs/zh/FLAGSHIP-TEMPLATES.md`](../../docs/zh/FLAGSHIP-TEMPLATES.md)（zh） | キュレートされた信頼フレームのギャラリー——インポートすれば動きます。スマートホーム、カフェ運営、家庭学習、個人コーディング。それぞれが触れられる/触れられないものを示し、キー不要のデモを提供。 |
| 🔧 **サーバーを実行している** | [`docs/DEPLOY.md`](../../docs/DEPLOY.md) | ローカルは `pnpm host`、公開は Caddy + systemd。 |
| 🚀 **ライブ公開する（3 トポロジー）** | [`docs/zh/GO-LIVE.md`](../../docs/zh/GO-LIVE.md) + [`deploy/`](../../deploy/) | 家庭ホスト + IM、クラウドホスト + IM、またはクラウド + 直接 IP。`deploy/.env.home` / `.env.cloud` をコピーし、ランブックに従う。IM ブリッジは送信ロングポール → NAT された家庭用ボックスはトンネル不要。（ランブックは zh；英語は近日公開予定。） |
| 🪢 **2 つの Hub をフェデレートする（チーム → 組織）** | [`docs/FEDERATION.md`](../../docs/FEDERATION.md) | `TeamBridgeAgent` はサブ Hub 全体を上流に単一エージェントとして表示します——内部メンバー/キー/サブタスクをプライベートに保ちます。 |
| 🔌 **Claude Desktop / Cursor / Cline から Hub を操作する** | [`docs/MCP.md`](../../docs/MCP.md) | `@aipehub/mcp-server` は MCP ブリッジです——5 つのツール（list / dispatch / evaluate / leaderboard / tasks）。MCP クライアント設定に 5 行追加するだけ。 |
| 🧰 **エージェントに MCP ツールエコシステムを提供する** | [`docs/MCP.md`](../../docs/MCP.md#6-outbound--using-third-party-mcp-tools-from-your-agent) | `@aipehub/mcp-client` により AipeHub エージェントが Filesystem / GitHub / Slack / Postgres / 任意の MCP サーバーを接続できます。`LlmAgent` は v0.3+ からマルチターンツールユーズループを標準で実行——`tools: toolset` を渡すだけで Claude / GPT がいつどのツールを呼ぶか決定。 |
| ⚖️ **ライセンス/商用利用について心配している** | [`docs/LICENSE-FAQ.md`](../../docs/LICENSE-FAQ.md) | 全体的に MIT。クローズドソース/SaaS への組み込み可能。コミュニティテンプレートは CC0 + MIT。 |
| 🧠 **その上で設計している** | [`docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md) + [`docs/PROTOCOL.md`](../../docs/PROTOCOL.md) | Hub は意図的に単純；ワイヤープロトコルは v1.0。 |
| 📊 **デプロイのサイジング** | [`docs/PERFORMANCE.md`](../../docs/PERFORMANCE.md) + [`docs/zh/CLOUD-RESOURCE-FOOTPRINT.md`](../../docs/zh/CLOUD-RESOURCE-FOOTPRINT.md) | プレローンチベースライン数値 + 自分のハードウェアに対してロードテストを再実行する方法。zh ドキュメントは**実際の本番測定値**（Feishu + MiMo、2 vCPU / 2 GiB ボックス上の単一 Hub）を追加し、負荷ごとの容量見積もりとアップグレードトリガーを提供——推論は Hub ではなく LLM プロバイダーで実行されるため、定常状態は RAM 約 110–160 MiB、CPU 約 0。 |
| 🛟 **本番運用** | [`docs/OPERATIONS.md`](../../docs/OPERATIONS.md) | バックアップ/リストアのプレイブック、障害復旧演習、`secret.key` の取り扱い、トラブルシューティング。 |
| 📡 **監視 + アラート** | [`docs/MONITORING.md`](../../docs/MONITORING.md) | Prometheus スクレイプ設定、ランブック付き 7 つのアラートルール、Grafana ダッシュボード JSON。 |

### エージェントの追加 — 2 つのパス

|  | ホスト管理（コードなし） | 外部 SDK（自分のコード） |
|---|---|---|
| **あなたがすること** | 管理 UI で YAML マニフェストをペースト/アップロード | `AgentParticipant.handleTask` を書き、`connect(url, agents)` を呼ぶ |
| **実行場所** | Hub プロセス内（LocalAgentPool） | ネットワーク上のどこでも |
| **できること** | Anthropic / OpenAI / Mock プロバイダー経由の LLM タスク | 何でも——LLM、スクレイパー、プライベートデータ、ML モデル、スクリプト |
| **API キーの場所** | `.aipehub/secrets.enc.json` に暗号化（エージェントごとまたはワークスペースデフォルト） | あなたのコードが読む場所 |
| **再起動時** | `LocalAgentPool` によって自動再起動 | あなたのコードが再接続（SDK には組み込みの自動リトライがある） |
| **最適な用途** | エンドユーザー・標準ロール・ワンクリックテンプレート | 開発者・プライベートロジック・クロス言語ワーカー |
| **読む** | [`docs/TEMPLATES.md`](../../docs/TEMPLATES.md) | [`docs/AGENT.md`](../../docs/AGENT.md) |

両方のパスが同じ Hub に接続されます。自由に混在——ルームはホスト管理の `writer-zh` とプライベート SDK 接続の `rag-agent` を並べて持てます。

このプロジェクトが何であるか——そして何になることを拒否するか：[`CHARTER.md`](../../CHARTER.md)。貢献する場合は [`CONTRIBUTING.md`](../../CONTRIBUTING.md) を参照。セキュリティ問題：[`SECURITY.md`](../../SECURITY.md)。バージョン履歴：[`CHANGELOG.md`](../../CHANGELOG.md)。

AipeHub を学ぶための最高のコミュニティ制作ビデオ、トーク、チュートリアルのキュレーションされた陳列館は [`LEARN.md`](../../LEARN.md) をご覧ください。プロジェクトの構築に貢献した人々 —— コード、ドキュメント、翻訳、コミュニティ、普及活動をすべて含む —— は [`CONTRIBUTORS.md`](../../CONTRIBUTORS.md) で認定されています。どちらも[表彰システムの支柱⑤](RECOGNITION-SYSTEM.md#pillar-5)の一部です。

## クイックスタート

### 非技術ユーザー？ダブルクリック、Node/Docker 不要

実行するマシンに**ターミナル、Node、Docker が一切不要**なパスです。メンテナーが一度自己完結型のポータブルバンドルをビルドします：

```bash
node scripts/build-portable.mjs        # → dist-portable/AipeHub-macos-arm64/
```

次に `AipeHub-macos-arm64/` フォルダー全体を誰にでも手渡します。**`AipeHub.command` をダブルクリック**→ ブラウザが 5 分間のセットアップウィザードを開きます。バンドルは独自のピン留めされた Node ランタイム + コンパイル済みホスト + 本物のオンディスク `node_modules`（ネイティブ SQLite バインディングを含む）を同梱しているため、何もインストールされていないマシンで**完全な**アイデンティティバックドホストを実行できます。データは `~/.aipehub`（フォルダーの外）に保存されるため、バンドルの置き換えでデータが失われることはありません。

オンデマンドでビルドされ、コミット/公開済みダウンロードではまだありません（それは post-1.0 の計画です）——現時点では「ダウンロード & 実行」は*フォルダーを一度ビルドし、フォルダーを共有する*ことを意味します。今回は macOS arm64。詳細な解説：[`docs/zh/PORTABLE-BUNDLE.md`](../../docs/zh/PORTABLE-BUNDLE.md)。

### 30 秒で起動——いずれか一つを選ぶ

```bash
# A. Docker（推奨——Node セットアップ不要、macOS / Windows / Linux で動作）
docker compose up
# → http://127.0.0.1:3000  + ログに印刷された管理 URL
# → 状態は ./data に永続化

# B. ソースから（クローンされたリポジトリ、完全なデモセット利用可能）
pnpm install
pnpm build
pnpm host
```

両方が同じバイナリを起動します。印刷された管理 URL を開く → トークンを保存 → 完了。

**初回起動の改善（新機能）。** 起動後、ホストはループバックセットアップウィザードを指す目立つ次のステップバナーを印刷し、ローカル（ループバック）初回起動時にはブラウザをそこに自動的に開きます：

```text
┌─ 下一步 / Next step ──────────────────────────

  打开浏览器完成 5 分钟设置 (设置向导,无需 token):
  Open your browser to finish the 5-minute setup:

      →  http://127.0.0.1:3000

  设置向导在本机回环 (loopback) 上运行。
  The setup wizard runs on loopback only.
└───────────────────────────────────────────────
  (已自动打开浏览器 / browser opened — AIPE_OPEN_BROWSER=0 关闭)
```

`AIPE_OPEN_BROWSER` は自動起動を制御します：未設定 = `auto`（初回ローカル実行のみ）、`1`/`always` = 毎回起動、`0`/`never` = オフ。ホストがネットワーク公開されているときも常にオフになります——ヘッドレスサーバーはブラウザを開かず、そのパスからウィザードにアクセスできません（そのパスは管理トークンファイルを使用します）。バナー自体は常に印刷されます。

> 💡 **配布。** この段階では `npm publish` はありません——Docker（A）とソース（B）が 2 つのサポートされたインストールパスです。以前の「v2.1 用にキュー」npm 計画は**スコープ外**になりました。レジストリの選択（npm / JSR / ソースのみ）は [RELEASE-CHECKLIST](.github/RELEASE-CHECKLIST.md) で追跡されているオープンな決定です。macOS / Windows 用の事前ビルド済み単一ファイルバイナリは計画されているが非ブロッキングなアイテムです——Docker はすでに「クリック & 実行」のクロスプラットフォームケースをカバーしています。

CLI フラグ（ビルドされたリポジトリから）：

```bash
pnpm exec aipehub-host --help       # 完全な環境変数リファレンス
pnpm exec aipehub-host --version    # 現在のホストバージョン
```

起動後、「次に何をすべきか」のウォークスルーは [`docs/OVERVIEW.md`](../../docs/OVERVIEW.md) を参照してください。

**起動しない場合？** 起動前にプリフライトチェックを実行してください——ホストが読む正確な `AIPE_*` 環境を検査し（Node バージョン、実際にバインド可能なポート、書き込み可能なデータディレクトリ、マスターキー）、チェックごとに ✓ / ⚠ / ✖ を 1 行の修正とともに印刷します：

```bash
pnpm exec aipehub doctor          # レポートのみ
pnpm exec aipehub doctor --fix    # 不足しているデータディレクトリも自動作成（唯一の安全で可逆的な修復）
```

そして起動が*失敗した*場合、ホストは一般的で回復可能な失敗（使用中のポート、ポートのバインド権限なし、見つからない/無効なマスターキー、書き込み不可のデータディレクトリ、ディスク満杯）を、どの `AIPE_*` 変数を変更するかを示す 1 行の人間向けメッセージに変換します——スタックトレースではありません。トラブルシューティングセクションは [`docs/zh/GO-LIVE.md`](../../docs/zh/GO-LIVE.md) §十一を参照してください。

**キープローブが機能することを確認する（本物のキー不要）。** 最も一般的な初回実行の落とし穴は、貼り付けた LLM キーが静かに機能しないことです。セットアップウィザードは「去补 key」救助パスでこれをキャッチします。このコマンドはその同じプローブをエンドツーエンドで実行し、オンボード前に救助パスが接続されていることを確認します：

```bash
pnpm check:onboarding          # ハーメティック——悪い/空のキー → 「キーを追加」、ネットワークエラー → 「URL を確認」を証明
ANTHROPIC_API_KEY=… pnpm check:onboarding   # ワイヤーで実際のキーをラウンドトリップ（オプトイン；キーなしでスキップ）
```

デフォルトではハーメティック（ネットワークなし、費用なし）で、キーをログに記録しません。Exit 0 = 実行されたすべてのチェックが合格。オプトインの実際のキーチェックはライブゲートの環境コントラクトをミラーします（DeepSeek パスの場合 `OPENAI_API_KEY` + `OPENAI_BASE_URL=https://api.deepseek.com` + `AIPE_LIVE_OPENAI_MODEL=deepseek-chat`）。

### クラウドサーバー（VPS）へのデプロイ

新鮮な Ubuntu/Debian ボックスを持っていますか？チェックアウトを置き（`git clone` でキーを使用するか、`scp` で転送——リポジトリはプライベートなので公開プルはありません）、一つのコマンドで systemd サービスをプロビジョニングします：

```bash
# チェックアウトの内部から、VPS 上で
sudo bash deploy/cloud-quickstart.sh        # Node+pnpm をインストール → ビルド → ユーザー+ユニット
#   最初にプレビュー、何も変更しない:  bash deploy/cloud-quickstart.sh --dry-run
```

Node + pnpm をインストールし、ビルドし、`aipehub` サービスユーザーとデータディレクトリを作成し、`/etc/aipehub.env`（[`deploy/.env.cloud`](../../deploy/.env.cloud) から）を配置し、[`docs/zh/DEPLOY.md`](../../docs/zh/DEPLOY.md) §C.4 をミラーする systemd ユニットをインストールします。**起動の一歩手前で停止します**——環境ファイルはドメイン/マスターキー/ホストアローリストが空白で出荷され、未設定のボックスを公開することは安全ではありません。安全な最後の一歩を印刷します：環境を埋め、[`scripts/cloud-harden.sh`](../../scripts/cloud-harden.sh)（周辺チェック）を実行し、Caddy + ファイアウォールを前に置いてから `systemctl enable --now aipehub` を実行。

> リポジトリがプライベートである間は**ブラウザの「ワンクリックデプロイ」ボタンはありません**（それらは公開リポジトリまたはプロバイダーアカウントが git に事前にリンクされている必要があります）。このコピペ可能なブートストラップが本物のテスト可能な等価物です。完全なランブック——トポロジー、IP 公開リスク、IM メンバーオンボーディング：[`docs/zh/GO-LIVE.md`](../../docs/zh/GO-LIVE.md)。

### 个人模式 (新, v4 Phase 7) — 一个人用 AI 干活, 0 配置

如果你就一个人, 想把 AipeHub 当成"我的 AI 桌面"用 (不是给团队开 hub),
直接 `docker compose up` 就行 — host 第一次启动检测到只有你一个用户,
**自动进入个人模式**:

```bash
docker compose up
# → http://127.0.0.1:3000/admin?token=<打印出来>
# → 首屏顶部不显示 "owner" 角色 chip (个人用户不需要看见组织角色)
# → 副标题写"我的 AI 桌面"(不是"管理员控制台")
# → 设置 tab 出现 [升级到团队模式] 按钮 — 哪天想拉人就点一下
```

个人模式与团队模式的差别就两点:
- 主页副标题文案不同 / role chip 隐藏
- 设置里多个升级按钮

**所有 admin tab 都还在**(用户管理 / peer / 配额 / audit 全可见),
但你不会被这些概念占满屏幕。需要时再用。

`AIPE_MODE=team` 可以强制 pin 团队模式(即使只有一个用户);
`AIPE_MODE=personal` 反过来——多用户时也强制 pin 个人模式(罕见,
通常给 dev / 测试场景)。

升级到团队后, 自动出现"邀请用户"流程, 跟着导出 admin URL 给团队成员;
路径见下一节 5-min personal growth workflow 或 [`docs/zh/OVERVIEW.md`](../../docs/zh/OVERVIEW.md)。

### 5 分間の個人成長ワークフロー（新機能）

最初の即実行可能な出荷済みエクスペリエンス。7 人のコーチ（インタビュー + 身体/心理/目標/リソース/関係 + 総合プランナー）を一度実行 → 12 週間の壁掛けマークダウンプランがディスクに保存されます。デフォルト LLM は **DeepSeek**（国内アクセス可能、安価）です。

```text
1. ホストをインストール（Docker またはソース、上記参照）
2. 印刷された管理 URL を開く → admin に進む
3. DeepSeek API キーを申請: https://platform.deepseek.com（新規ユーザーには 10 元のクレジット、数十回実行可能）
4. Admin → ワークフロータブ → [チームをインポート (bundle)] をクリック → [🎁 組み込みテンプレートを使用: 個人成長] をクリック
   → DeepSeek キーを貼り付け → [インポート]
   （7 つのエージェントがワンクリックで作成され、ワークフローが自動登録）
5. ワークフローカードで [開始] をクリック → 4 段のフォームが表示（現状/願望/詰まり/今回最も考えたいこと）
6. ディスパッチ → 約 3.5 分待機（7 回の DeepSeek API コール）
7. ワークフロータブを下にスクロール → 「成長レポート」パネル → [ダウンロード] をクリック
   または: <space>/services/artifact/file/agent/growth-synthesist/reports/<caseId>/<date>.md
```

レポートには：プロファイル + 身体/心理/目標/リソース/関係の 5 次元分析 + 一文の発展パス + **12 週間壁掛けプラン**（メインライン + サブライン、毎週の取り組み）+ **5 つのトレードオフ判断** + 「できない場合の」ダウングレード案 + 「v2 のワークフロー実行時に答えることをお勧めする 5 つのシード質問」（次回に使用）が含まれています。

> 🙏 **プライバシー/データについて**：あなたの 4 段の自己述が推論のために DeepSeek（中国本土サーバー）に送信されます。ワークフロー完了後、すべての出力はあなた自身のコンピューターの `.aipehub-*/services/` ディレクトリに保存され、クラウドにはアップロードされません。各コーチは境界のある伴走者として設計されています——身体コーチは危険信号（持続する胸痛/原因不明の出血など）に触れた場合、医師に連絡するよう促します。心理コーチはリスク信号に触れた場合、24 時間危機ホットライン（全国 400-161-9995 / マレーシア Befrienders 03-7956 8144）を提供します。**これは医師/心理カウンセラー/ファイナンシャルアドバイザー/関係セラピストの代替品ではありません。**

Anthropic Claude または OpenAI に切り替えたいですか？`templates/teams/personal-growth-team.yaml` を編集し、各エージェントの `provider` / `baseURL` / `model` を変更するだけです——システムプロンプトはベンダーに依存しません。

### ログ記録

構造化ログは**デフォルトでオン**——stdout がパイプされている場合（`jq` / Loki / ELK / Datadog 向け）はイベントごとに JSON 行、stdout がターミナルの場合はきれいに印刷されます。3 つの環境変数で制御します：

```bash
AIPE_LOG_LEVEL=info       # silent | trace | debug | info（デフォルト） | warn | error | fatal
AIPE_LOG_FORMAT=json      # json | pretty（デフォルト：TTY により自動）
AIPE_LOG_DISABLED=1       # ハードオフのエスケープハッチ
```

JSON 出力を取得したら `jq` でコンポーネントごとにフィルタリング：

```bash
pnpm host 2>&1 | jq 'select(.comp == "local-agents")'
```

### デモ（クローンされたリポジトリ）

`pnpm install && pnpm build` した後、フレームワーク内のすべての協力パターンに実行可能なデモがあります：

```bash
# インプロセスデモ（ネットワーク不要）
pnpm demo                # 2 つのモックエージェント + 1 つのモック人間
pnpm demo:broadcast      # 3 人のレビュアーが競い、負けはキャンセル

# 永続化デモ
pnpm demo:persist:fresh && pnpm demo:persist:resume
pnpm demo:persist:sqlite:fresh && pnpm demo:persist:sqlite:resume

# リモートエージェント
pnpm demo:remote         # ホスト + ワーカーが別プロセスで
pnpm demo:remote:python  # Node ホスト + Python ワーカー（クロスランゲージ）
pnpm demo:cli-human      # ターミナルを人間の承認ループとして

# LLM バックエンドエージェント
pnpm demo:llm            # LlmAgent + モックプロバイダー（API キー不要）
pnpm demo:llm:real       # 本物の Claude/GPT（ANTHROPIC_API_KEY/OPENAI_API_KEY が必要）

# v2.0 フルスタック——Web UI + エージェント入場 + タスクパネル
pnpm demo:open-space
pnpm demo:federated-team # 一つの Hub が別の Hub に単一エージェントとして参加
```

### 上手案例 — 5 个开箱即用的 hub（すぐに使える Hub）

上記のパターンデモを超えて、5 つの `examples/` ケースは**完全なコピー可能な Hub**です——それぞれ決定論的なキー不要のデモ *と* ワンファイルのロード可能テンプレート（エージェント + ワークフロー + KB 配線）を同梱しています。3 つの個人用（「私の AI デスクトップ」）、2 つの組織用（チームモード）：

```bash
# 個人 Hub（ルーター LLM がサブエージェント / CLI を調整）
pnpm demo:personal-coding-hub      # 共有リポジトリで Claude Code + Codex をルーティング
pnpm demo:personal-research-hub    # 生のソースをリンクされた Obsidian wiki にコンパイル
pnpm demo:battle-monk-training     # 永続的なコーデックスに状態を書き込む成長コーチ

# 組織 Hub（宣言的ワークフロー + surface.me セルフサービス + human: HITL 承認）
pnpm demo:cafe-ops                 # 奶茶/コーヒーショップ: オンボーディング / シフト / 残業、マネージャーが承認
pnpm demo:warband-club             # 一つの共有アーカイブで協力するファンクラブ
```

一つを選び、決定論的デモを確認してから、本物の DeepSeek + Obsidian でライブに——完全なカタログとライブランブックは **[`docs/zh/HANDS-ON-HUBS.md`](../../docs/zh/HANDS-ON-HUBS.md)**。

## 組み込み——すべてを一つのプロセスで

```ts
import { Hub, Space } from '@aipehub/core'

// v2.0: ディレクトリにバインド; 管理者、ワーカー、トランスクリプトはすべてここに
const { space, adminToken } = await Space.openOrInit('.aipehub', {
  name: 'my-space',
  adminDisplayName: 'Operator',
})
console.log(`Admin URL once: http://localhost:3000/admin?token=${adminToken}`)

const hub = new Hub({ space })
await hub.start()
hub.register(new MyAgent())
hub.register(new MyHumanAdapter())

const result = await hub.dispatch({
  from: 'admin',
  strategy: { kind: 'capability', capabilities: ['draft'] },
  payload: { topic: 'why TypeScript' },
})

// テスト / 永続化なしのインプロセスデモ:
const tmp = Hub.inMemory()
```

## 分散——エージェントが別のプロセス/マシンから接続

ホストプロセス（Hub）：

```ts
import { Hub } from '@aipehub/core'
import { serveWebSocket } from '@aipehub/transport-ws'

const hub = new Hub()
await hub.start()
await serveWebSocket(hub, { port: 4000 })
```

ワーカープロセス（任意のエージェント、どこでも）：

```ts
import { AgentParticipant, connect } from '@aipehub/sdk-node'

class MyAgent extends AgentParticipant {
  constructor() { super({ id: 'a1', capabilities: ['draft'] }) }
  protected async handleTask(task) { return { text: '…' } }
}

await connect({ url: 'ws://hub.example.com:4000', agents: [new MyAgent()] })
```

Hub の `dispatch(...)` 呼び出しは、ローカルエージェントとまったく同様にリモートエージェントに届きます。ワイヤーフォーマットは [docs/PROTOCOL.md](../../docs/PROTOCOL.md)、実行可能な 2 プロセスデモは [examples/remote-agent](../../examples/remote-agent) を参照してください。

## LLM バックエンドエージェント

Hub は LLM を呼び出しません。`LlmAgent` が呼び出します——タスクを `LlmProvider` に接続し、レスポンスを `TaskResult` に変換する薄い基底クラスです。ベンダーの切り替えは 1 行の変更です。

```ts
import { Hub } from '@aipehub/core'
import { LlmAgent } from '@aipehub/llm'
import { AnthropicProvider } from '@aipehub/llm-anthropic'
import { OpenAIProvider } from '@aipehub/llm-openai'

const hub = new Hub()
await hub.start()

// Claude がドラフトを書く
hub.register(new LlmAgent({
  id: 'writer',
  capabilities: ['draft'],
  provider: new AnthropicProvider(),        // ANTHROPIC_API_KEY を読む
  system: 'You write one terse sentence.',
}))

// GPT がレビューする
hub.register(new LlmAgent({
  id: 'reviewer',
  capabilities: ['review'],
  provider: new OpenAIProvider(),            // OPENAI_API_KEY を読む
  system: 'You return one revision suggestion.',
}))

const draft = await hub.dispatch({
  from: 'system',
  strategy: { kind: 'capability', capabilities: ['draft'] },
  payload: { topic: 'distributed agents' },
})
```

プロンプトアセンブリ（取得されたコンテキスト、フューショット例）をカスタマイズするには `buildRequest(task)` をオーバーライドし、後処理（JSON 抽出、バリデーション再プロンプト）には `parseResponse(response, task)` をオーバーライドします。完全制御には `handleTask(task)` をオーバーライドします——マルチステップ推論、リトライ、構造化出力。[`packages/llm`](../../packages/llm/src/agent.ts) と [`examples/llm-mock`](../../examples/llm-mock) および [`examples/llm-real`](../../examples/llm-real) の 2 つのデモを参照してください。

## オープンスペース——管理者、ワーカー、エージェントが一つの部屋で（v2.0）

`.aipehub/` ディレクトリに Hub をアンカーします；管理者の識別情報、ワーカーアカウント、ゲートされたエージェント入場がすべてここにあります。Web UI は 2 つのビューに分かれます（`/` ワーカー、`/admin` 管理者）。Hub の再起動は透明です——Cookie は引き続き機能し、管理者は管理者のまま、トランスクリプトは再起動ではなく成長します。

```ts
import { Hub, Space } from '@aipehub/core'
import { serveWebSocket } from '@aipehub/transport-ws'
import { serveWeb } from '@aipehub/web'

const { space, adminToken } = await Space.openOrInit('.aipehub', {
  name: 'my-space',
  adminDisplayName: 'Operator',
  config: { gating: 'admin-approval' },
})
console.log(`Admin URL once: http://localhost:3000/admin?token=${adminToken}`)

const hub = new Hub({ space })
await hub.start()

await serveWebSocket(hub, { port: 4000, gating: (await space.config()).gating })
await serveWeb(hub, { port: 3000 })
// admin = /admin?token=<TOKEN>   |   worker = /
```

- **管理者**はトークンで一度サインインし、部屋を管理します：保留中のエージェント入場を承認/拒否し、3 つの戦略のいずれかでタスクをディスパッチし、失敗行に**リトライ**ボタン付きのフィルタリング可能なパネルですべてのタスクを確認し、特定のタスクに評価を記述します。
- **ワーカー**は `/` でニックネームと機能を選択し、`HumanParticipant` になります。`workers.json` の行と HttpOnly Cookie が再読み込みと再起動にわたって記憶します。
- **エージェント**は WebSocket ポートに接続します；`gating: 'admin-approval'` では管理者が対応するまで保留中にハングします。

完全な実行可能デモは [`examples/open-space`](../../examples/open-space) にあります。`pnpm demo:open-space` はホスト + エージェントを 1 つのターミナルで起動し、印刷される 2 つの URL にブラウザを向けます。

## Hub サービス——エージェントメモリ、アーティファクト、データストア（v2.2）

エージェントは、ホストが代わりに保持する状態を宣言できます。今日は 3 つのファーストパーティ「サービス」が出荷されています；プランビングは day-1 からプラグインであるため、4 つ目の追加は別の npm パッケージです。

```yaml
# templates/agents/industry-coach-with-memory.yaml
schema: aipehub.agent/v1
agent:
  id: industry-coach
  capabilities: [intake]
  provider: anthropic
  model: claude-opus-4-7
  system: |
    Use memory.recall before answering; artifact.write the report
    afterwards; cases.sql for structured industry comparisons.
  uses:
    - { type: memory,    impl: file,   config: { kinds: [episodic, semantic] } }
    - { type: artifact,  impl: file,   config: { name: industry-reports } }
    - { type: datastore, impl: sqlite, config: { name: cases, schema: "..." } }
```

起動時にホストは各 `uses:` エントリを、エージェントが `ctx.memory`、`ctx.artifact`、`ctx.datastore.<name>` から読む型付きハンドルに解決します。所有者ベースの分離がデフォルト——`memory:file` を要求する 2 つのエージェントは 2 つの異なるストアを取得します。データレイアウトは `<space>/services/` 下にあります：

```
<space>/services/
├─ plugins.json                    # どのプラグインをロードするか（自動シード）
├─ memory/file/agent/<agentId>/    # (プラグイン, 所有者) ごとに 1 ディレクトリ
├─ artifact/file/agent/<agentId>/
└─ datastore/sqlite/agent/<agentId>/<name>.sqlite
```

ソフト削除は管理者の「服务 / Services」タブでクリック一つ；データはプラグインごとの `.trash/` に移動し、30 日間保存された後にバックグラウンドスウィーパーがハード削除します。それまでは 1 つの POST で復元できます。完全な設計は [`docs/services-rfc.md`](../../docs/services-rfc.md)。

| パッケージ | 提供するもの |
|---|---|
| `@aipehub/services-sdk` | `ServicePlugin` コントラクト、レジストリ、ローダー。プラグイン作成者が実装する接合部。 |
| `@aipehub/service-memory-file` | ファーストパーティ `memory:file` — JSONL としてのエピソード/セマンティック/ワーキング。 |
| `@aipehub/service-artifact-file` | ファーストパーティ `artifact:file` — MIME + サイズガード付きの所有者ごとのファイルディレクトリ。 |
| `@aipehub/service-datastore-sqlite` | ファーストパーティ `datastore:sqlite` — 宣言された名前ごとに 1 つの `.sqlite` 上の KV + 生 SQL。 |

### 独自のプラグインを書く

```ts
// my-plugin/src/index.ts
import type { ServicePlugin } from '@aipehub/services-sdk'

class MyPlugin implements ServicePlugin {
  readonly type = 'memory'
  readonly impl = 'redis'
  readonly version = '0.1.0'

  async init(ctx) { /* Redis プールを開く */ }
  async validateConfig(raw) { /* 解析 + 悪い形状を拒否 */ }
  async attach(owner, config) { /* MemoryHandle を返す */ }
  async detach(owner) { /* 所有者ごとのキャッシュを閉じる */ }
  async softDelete(owner) { /* TrashRef を返す；ホストが保存 */ }
  async restore(ref) { /* 衝突時に TrashRestoreConflictError をスロー */ }
  async hardDelete(ref) { /* 不可逆 */ }
  async describe(owner) { /* 管理 UI スナップショット——sizeBytes、プレビュー */ }
  async shutdown() { /* ドレイン + クローズ */ }
}

export default () => new MyPlugin()
```

パッケージ名を `<space>/services/plugins.json` に入れてホストを再起動——`loadPlugins` がエントリを動的インポートし、`init` を呼び出し、プラグインがすべてのエージェントの yaml `uses:` で利用可能になります。プラグインのロード失敗は致命的ではありません：悪いプラグインは起動ログに表示されますが、ホストをクラッシュさせません。

> **デプロイ注記**：ホストは独自の `node_modules/` からプラグインパッケージを解決するため、サードパーティプラグインはホストが見える場所にインストールされる必要があります——ホストワークスペースで `pnpm add my-org/aipehub-redis-memory`、またはデプロイイメージへの `package.json` 依存関係。パッケージ名を `plugins.json` に入れるだけでは、パッケージ自体がディスクにない場合は不十分です。

## パッケージ

| パッケージ | 目的 |
|---|---|
| `@aipehub/core` | Hub、レジストリ、スケジューラー、トランスクリプト、ストレージ、Participant 基底クラス |
| `@aipehub/web` | 組み込み可能なリファレンス UI（HTTP + SSE + バニラ SPA） |
| `@aipehub/host` | 本番バイナリ——環境変数駆動、デモ状態なし、`aipehub-host` を出荷 |
| `@aipehub/protocol` | ワイヤープロトコルの型 + コーデック（ゼロランタイム） |
| `@aipehub/transport-ws` | Hub 側 WebSocket トランスポート |
| `@aipehub/sdk-node` | リモートエージェント向け Node SDK（`TeamBridgeAgent` もエクスポート） |
| `@aipehub/llm` | `LlmAgent` 基底クラス + `LlmProvider` インターフェース + `MockLlmProvider` |
| `@aipehub/llm-anthropic` | Anthropic Claude プロバイダー（ピア依存: `@anthropic-ai/sdk`） |
| `@aipehub/llm-openai` | OpenAI プロバイダー（ピア依存: `openai`） |
| `@aipehub/services-sdk` | Hub サービスプラグインコントラクト（v2.2）——上記セクション参照 |
| `@aipehub/service-memory-file` | ファーストパーティ `memory:file` プラグイン（ディスク上の JSONL） |
| `@aipehub/service-artifact-file` | ファーストパーティ `artifact:file` プラグイン（所有者ごとのディレクトリ、MIME ゲート） |
| `@aipehub/service-datastore-sqlite` | ファーストパーティ `datastore:sqlite` プラグイン（KV + SQL） |
| `@aipehub/mcp-server` | MCP（Model Context Protocol）ブリッジ——Claude Desktop / Cursor が Hub を操作できるようにする |
| `aipehub`（PyPI、`python-sdk/` 内） | Python SDK——同じワイヤープロトコルで Python エージェントを Hub に接続 |

## ライセンス

プロジェクト自体は **MIT** ——[`LICENSE`](../../LICENSE) を参照。

- ✅ 商用利用、クローズドソース派生物、内部 SaaS 組み込み——すべて許可。
- ⚠️ 配布物にライセンスファイル + 著作権表示を保持してください。
- [`templates/community/`](../../templates/community/) の下のサードパーティプロンプトテンプレートは独自の（互換性のある）ライセンスを持ちます——CC0 1.0 と MIT——[`templates/community/LICENSE-NOTICES.md`](../../templates/community/LICENSE-NOTICES.md) に逐語的に集約されています。

一般的な質問（「クローズドソースに組み込めるか」「コミュニティテンプレートを帰属する必要があるか」「フォーク+リネームは許可されているか」）は [`docs/LICENSE-FAQ.md`](../../docs/LICENSE-FAQ.md) で回答されています。
