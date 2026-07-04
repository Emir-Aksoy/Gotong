# 競合 & エコシステムランドスケープ: リアルワークフロー埋め込み × 複数人 × 複数エージェント協働

<!-- doc-version: 1.0 -->
> **ドキュメントバージョン 1.0** · 日本語訳 · 最終更新 2026-06-27 · 権威ある原典：[English](../COMPETITIVE-LANDSCAPE.md)。訳文と英語版に矛盾がある場合は、英語版が優先されます。

> 調査日: 2026-05-29。四つのトラックにわたる 30 以上のプロジェクト / プロトコルをカバー。エージェントと人間の両方の読者向けに書かれています。
> 一行の結論: **Gotong の四本柱をすべて同時に持つ競合他社は一つもない** — ダムハブ（決定は参加者に宿る）/ 人間 = エージェントが一つの統合 `Participant` / ファイルが状態 / 組織主権フェデレーション。市場は四つのブロックに分かれており、それぞれが一本か二本の柱を持ち、残りは欠いています。
>
> 関連資料: [`PRODUCT-MATRIX.md`](../PRODUCT-MATRIX.md)（2026-06-21）— 製品レベルの一対一マトリックス（強みの表一つ、弱みの表一つ）+「実際のニーズを持つが今日は満たされていないどのユーザーに最適か」+ DeepSeek の価格引き下げがそのセルをどう解放するか。このドキュメントがトラックマップ; あちらが製品レベルのターゲットユーザー判断です。

---

## 1. トラックマップ

| トラック | 代表的なプレイヤー | 共通のスタンス | 私たちとの根本的な違い |
|---|---|---|---|
| **① マルチエージェントオーケストレーションフレームワーク**（ライブラリレベル） | AutoGen→AG2 / MS Agent Framework、CrewAI、LangGraph、OpenAI Agents SDK、MetaGPT、CAMEL、Semantic Kernel、Google ADK、LlamaIndex Workflows、Pydantic AI | **フレームワークが脳** — ライブラリ自体が LLM を実行し、制御ループ / ターン管理 / SOP 自体を保持する | ハブはダムルーター; 決定は常に参加者の手に宿る |
| **② エージェント相互運用プロトコル** | MCP、A2A、（IBM ACP→A2A に統合）、AGNTCY/SLIM、NANDA、LMOS、Matrix、ANS/OIDC-A | 2025 年下半期に**Linux Foundation** に集合的に吸収され、「ツール層（MCP）+ エージェント層（A2A）」に階層化 | MCP は既に実装済み; フェデレーション層は独自実装で A2A に整合すべき |
| **③ AI ワークフロー自動化プラットフォーム**（ローコード / 製品レベル） | n8n、Zapier Agents、Make、Activepieces、Windmill、Gumloop、Relay、Lindy、Sema4、Copilot Studio、Dify、Flowise | **LLM がキャンバスにノードとして溶接**されている; **人間は「一時停止 / 承認待ち」ノード** | ランナーは LLM ゼロ（宣言型）+ 人間はタスクを受け取る参加者 |
| **④ セルフホストプラットフォーム / 耐久実行 / チャット as ハブ** | Dify、Flowise、Langflow、Rivet、LibreChat、Open WebUI、AnythingLLM; Temporal、Inngest、Restate、DBOS; Slack+Agentforce、Mattermost、Rocket.Chat、LangBot、Letta | 状態が DB / クラウドにロック; 耐久エンジンはただのヘッドレスバックエンド; チャットハブはサスペンド / レジュームがない | ブリッジ + ハブ + エージェント + ファイル状態が 1 つのセルフホストバイナリにパッケージ |

---

## 2. ポジショニング

> 他は「**フレームワークが脳**」（①）、または「**LLM がキャンバスに溶接され、人間が承認ノード**」（③）、または「**ただのバックエンドエンジン / ただのメッセージブリッジ**」（④）です。Gotong は「**ダムハブ + 人間が参加者 + ファイルが状態 + 組織主権フェデレーション**」 — **コラボレーション基盤**であり、もう一つのインプロセスオーケストレーターではありません。

---

## 3. 防御的優位性（アーキテクチャ上の優位点）

1. **ダムハブ / 決定は参加者に宿る** — ①のどれも受動的なルーターではない; すべてがインプロセスで LLM を実行し、決定を保持します。LlamaIndex Workflows の「ループはあなたが所有」の精神だけが近いですが、それでもインプロセスのイベントエンジンです。単一のベンダー SDK にロックされない — Swarm→Agents SDK および AutoGen→MAF の連続的な混乱は、まさに「ランタイム結合」のリスクを証明しています。
2. **人間とエージェントは同じ `Participant`** — すべての競合他社が人間を特別なケースとしてモデル化しています: UserProxyAgent（AutoGen）/ interrupt（LangGraph）/ deferred-tool（Pydantic）/ グラフノード（ADK）/「Human Input」ノード（Dify）/ Outlook 承認フォーム（Copilot）。**それらの誰も人間とエージェントを同じメッセージ + タスク + トランスクリプトバス上の対等なピアにしていません。**
3. **ファイルが状態、ポータブルで監査可能** — 競合他社の状態はメモリ / SQLite / Postgres / Redis / Mongo / ベンダークラウドに存在します。最も近いのは単一の SQLite ファイル（Flowise/Open WebUI）、クエリ可能な Postgres 行（DBOS）、または YAML グラフ定義（Rivet）に過ぎません。**transcript + agents + sessions + secrets + vault をすべて grep / diff / rsync / 手編集できるプレーンファイルとして保存するものはありません。**「ディレクトリをコピー = 部屋を移動」は最強の差別化要因です。
4. **組織ごとの暗号化ボールト + 組織ごとの API クォータがファーストクラス市民** — Windmill（ワークスペースキー暗号化）と Copilot（Key Vault）が最も近いですが、「組織ごとの孤立したクレデンシャルストア + 組織ごとの LLM クォータ」をフェデレーション対応境界としてモデル化するものはありません。プロトコル層（A2A/MCP）は「認証スキームを宣言する」までであり、シークレットストレージやクォータについては何もありません。
5. **組織間フェデレーション + クレデンシャル / データ / 課金はそれぞれホームに留まる** — 最も明確な空白スペースです。③はすべてシングルテナントまたはシングルベンダー SaaS で、チーム / ワークスペースは 1 つのデプロイメント内でのみ分割します; ④のエンジンはただのバックエンドです。**ワークフローが組織の境界を越えながら各組織がクレデンシャル / データ / クォータを保持できるオープン P2P フェデレーションを提供するものはありません。**そして**「クロスハブ HITL」（組織 B の人間が組織 A が開始したタスクを満たす）は A2A（150 以上の組織標準）でさえカバーされていません** — A2A には `input-required` タスク状態のみがあり、組織間の人間参加者モデルはありません。

---

## 4. 弱点（正直なリスト）

1. **統合 / コネクターの幅** — 最大の現実世界の優位性は反対側にあります: Zapier 8000+、Make 3000+、Lindy 4000+、n8n 1200+。私たちは現在ほぼゼロです。
2. **UX の洗練度 + NL オーケストレーション** — Make の Reasoning Panel、Gumloop の「Gummie」NL→ワークフロー、Relay の HITL 体験はすべて YAML ファースト（NL→YAML アシスタントがあっても）より成熟しています。
3. **耐久性の成熟度** — Temporal（シグナル + 無期限のゼロリソース待機 + イベントリプレイ）/ DBOS（何週間もの耐久スリープ）/ Inngest / Restate はサスペンド / レジュームにおいて**数年先を行っています**。私たちの `SuspendTaskError` + SQLite スイープは概念的には同じですが、若く、シングルノードで、保証が弱いです。
4. **エンタープライズガバナンス** — Copilot（Entra ID + Key Vault + きめ細かい RBAC）、Windmill（5 ロール + フォルダ ACL）、Lindy/Sema4（SOC2/HIPAA）の SSO / 監査 / コンプライアンスストーリーは、私たちがまだ構築していないものです。
5. **マルチエージェントオーケストレーション UX** — Flowise Agentflow（スーパーバイザー / ワーカー、競合解決、動的ロール）、Lindy Agent Swarms、Zapier エージェント間呼び出しはすべて完成した製品 UI です; 私たちにはディスパッチプリミティブしかありません。
6. **IM の幅は独自ではない** — LangBot はすでにより多くのプラットフォーム（DingTalk / LINE / KOOK / WeChat Official Accounts + DingTalk/LINE/KOOK/WeChat 公式アカウント）をブリッジし、バックエンドに依存しません。「6 ブリッジ」は生の幅においては優位性ではありません — 優位性は「ファイル状態と参加者モデルを持つハブであり、ハブはただのルーター」です。
7. **エコシステム / マインドシェア** — 反対側には 50k〜110k スター（CrewAI 52k、MetaGPT 68k、Dify 110k+）があります; 私たちはまだ初期段階です。

---

## 5. 相互運用プロトコル層（最も実行可能な整合ターゲット）

2025 年下半期に、相互運用プロトコルは Linux Foundation に集合的に吸収され、2 つの層に分割されました。Gotong は両方にまたがっています:

- **ツール層（エージェント↔ツール）: MCP が完全勝利。** 2025-12 に Anthropic が LF ホストの **Agentic AI Foundation（AAIF）**（OpenAI/Block と共同構築）に寄贈、月間約 9700 万ダウンロード、約 10k サーバー。
- **エージェント層（エージェント↔エージェント間組織）: A2A が完全勝利。** 2025-06 に LF に参加; **IBM ACP を 2025-08 に吸収**; 1 周年時点で、**150 以上の組織**が本番使用。
- 残りはその上下に積み重なります: **AGNTCY/SLIM** = インフラ / トランスポート層; **NANDA** = 研究グレードのアイデンティティ信頼（DID + AgentFacts）; **Matrix** = 私たちの哲学的いとこ（フェデレーション、主権、自分のサーバー上の状態）。

| プロトコル | 層 | ガバナンス | 組織間アイデンティティ | トランスポート / セマンティクス | 採用状況 |
|---|---|---|---|---|---|
| **MCP** | ツール呼び出し | Anthropic→AAIF/LF | OAuth2.1 + PKCE + RFC8707（クライアント↔サーバー） | 両方（JSON-RPC / stdio / Streamable HTTP） | 支配的 |
| **A2A** | エージェント↔エージェント | Google→LF | エージェントカードが OAuth2 / OIDC / APIキー / mTLS を宣言 | 両方（JSON-RPC / HTTPS + SSE） | 150 以上の組織 |
| ACP（IBM） | エージェント↔エージェント | →A2A に統合（2025-08） | （統合済み） | — | 非推奨 |
| AGNTCY + SLIM | ディスカバリー + アイデンティティ + **トランスポート** | Cisco→LF | 分散型エージェントアイデンティティサービス | SLIM = トランスポート（gRPC/H2/H3）、A2A/MCP を運搬 | 75 以上の企業 |
| NANDA | ディスカバリー + アイデンティティ + 経済 | MIT Media Lab | DID + 検証可能クレデンシャル + AgentFacts | セマンティック（レジストリ） | 研究 / 本番未稼働 |
| Matrix | フェデレーションメッセージ**トランスポート** | Matrix.org | ホームサーバーフェデレーション MXID | トランスポート | 6000 万以上のユーザー |

**Gotong フェデレーションプリミティブ → 標準マッピング:**

| 私たちのプリミティブ | 整合する標準 | 結論 |
|---|---|---|
| `peerToken` | A2A 認証スキーム（Bearer / OAuth2 / OIDC / mTLS） | **整合** — A2A 宣言スキームとして再表現 |
| `Task.origin` | A2A タスクメタデータ / OIDC-A 委任チェーン | **先行** — 保持し、A2A タスクメタデータにマッピング |
| インバウンド ACL | A2A「opaque agents」+ 選択的開示 | 保持、意味的に整合 |
| 組織ごとのボールト | （標準なし） | **独自、保持** |
| 組織ごとのクォータ（OrgApiPool） | （標準なし; NANDA の経済層に近い、研究中） | **独自、保持** |
| ピアレジストリ + 評判 | A2A レジストリ / NANDA Index / ANS | 長期整合、NANDA の検証可能な方向をトラック |
| クロスハブ HITL | **プロトコルがカバーしていない** | **独自 + 北極星を達成** |

---

## 6. 強化の方向性（「レバレッジ / 北極星への貢献」順）

**🔴 高レバレッジ**
1. **A2A に整合（単一の最高価値の動き）** — `/.well-known/agent-card.json` を公開し、`peerToken` を A2A 宣言の Bearer/OAuth2/mTLS スキームとして再表現し、Gotong ハブが Gotong↔Gotong だけでなく 150 以上の組織の A2A エコシステムとフェデレーションできるようにします。エンドツーエンドの `Task.origin` 出所は実際に A2A の現在の仕様より先行しています。
2. **MCP エコシステムを通じて統合の幅を埋める**、独自のコネクターを構築するのではなく — MCP はすでに約 10k サーバーで LF ホストされています。「統合能力 = MCP サーバーをインストール」をファーストクラスのオンボーディングにし、相手の「8000 コネクター」優位性を「オープンスタンダードを採用」に変えます。
3. **ディスパッチプリミティブを再利用可能なオーケストレーションテンプレートにアップグレード** — スーパーバイザー / ワーカー、ディベート、スウォームパラレルを `templates/` に構築し、Flowise Agentflow / Lindy Swarms の完成した体験に合わせます（architect-team がすでに基盤を築いています）。

**🟡 中レバレッジ**
4. **耐久性: 正直なキャリブレーション + オプションの強力なバックエンド** — 私たちと Temporal/DBOS の保証境界の真の比較を文書化します; **DBOS/Temporal バックエンドモード**（オプション）でサスペンド / レジュームを実現することを検討します（DBOS は自分の Postgres に状態を持つライブラリで、「状態はあなたに見える」の精神に最も適合します）。
5. **HITL ハンドオフ UX の磨き上げ** — 概念的には Slack/Rocket.Chat を超えていますが、完成したエスケープハッチが欠けています: 「完全なコンテキストで人間に引き渡す / 複数人承認 / タイムアウトエスカレーション」を既成テンプレートとして構築します。
6. **エンタープライズガバナンスの補完** — SSO（OIDC/SAML）、監査ログ、きめ細かい RBAC、組織シナリオのバーをクリアするため。

**🟢 監視 / 長期**
7. **アイデンティティ信頼層を監視** — NANDA（DID + AgentFacts）/ ANS / OIDC-A 委任チェーンは「ピアレジストリ + 評判」の検証可能な将来バージョンですが、どれもまだ標準として承認されていないため、**今は採用せず**トラックします。
8. **ポジショニングの語り** — 外部に「**エッジ A2A/MCP ネイティブだが、ワイヤープロトコルが意図的に無視する組織境界プリミティブ（ボールト / クォータ / クロスオーグ HITL / 起源出所）を携えている**」ことを明確にします。

**最終結論**: 耐久性で Temporal/DBOS と競合したり、統合の幅で Dify/n8n と競合したりしないでください。防御的な楔は**その組み合わせ**です: ファイルファーストのポータビリティ + 参加者としての人間 + 複数の IM ネイティブブリッジ + 十分なサスペンド / レジューム、すべてが 1 つのセルフホスト OSS バイナリにまとめられています。最も埋める価値のある 2 つのこと: **A2A 整合**（エコシステムリーチのため）+ **MCP ルートによる統合**。

---

## 7. 主要参考文献

**プロトコル**
- MCP→AAIF/LF: anthropic.com/news/donating-the-model-context-protocol-and-establishing-of-the-agentic-ai-foundation ; linuxfoundation.org/press/linux-foundation-announces-the-formation-of-the-agentic-ai-foundation
- A2A→LF: linuxfoundation.org/press/linux-foundation-launches-the-agent2agent-protocol-project... ; 150+ 組織: linuxfoundation.org/press/a2a-protocol-surpasses-150-organizations...
- ACP→A2A: lfaidata.foundation/communityblog/2025/08/29/acp-joins-forces-with-a2a...
- A2A ディスカバリー / エージェントカード: a2a-protocol.org/dev/topics/agent-discovery/
- AGNTCY/SLIM: outshift.cisco.com/blog/building-the-internet-of-agents-introducing-the-agntcy ; datatracker.ietf.org/doc/draft-mpsb-agntcy-slim
- NANDA: arxiv.org/abs/2507.07901 ; media.mit.edu（Beyond DNS / AgentFacts）

**フレームワーク**
- AG2: github.com/ag2ai/ag2 ; MS Agent Framework: github.com/microsoft/agent-framework
- CrewAI: github.com/crewAIInc/crewAI ; LangGraph: github.com/langchain-ai/langgraph
- OpenAI Agents SDK: openai.github.io/openai-agents-python ; MetaGPT: github.com/FoundationAgents/MetaGPT
- Google ADK + A2A: google.github.io/adk-docs/a2a/ ; Pydantic AI: github.com/pydantic/pydantic-ai

**プラットフォーム / エンジン**
- n8n HITL: docs.n8n.io/advanced-ai/human-in-the-loop-tools/ ; Zapier Agents: zapier.com/blog/zapier-agents-guide/
- Dify: github.com/langgenius/dify（Human Input ノード: releases/tag/1.13.0）; Flowise Agentflow: docs.flowiseai.com/using-flowise/agentflowv2
- Windmill: windmill.dev/docs/core_concepts/variables_and_secrets ; Copilot Studio: learn.microsoft.com/microsoft-copilot-studio/flows-advanced-approvals
- Temporal HITL: docs.temporal.io/ai-cookbook/human-in-the-loop-python ; DBOS: github.com/dbos-inc/dbos-transact-py
- LangBot: github.com/langbot-app/LangBot ; Letta: github.com/letta-ai/letta
