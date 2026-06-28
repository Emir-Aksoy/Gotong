# フラッグシップテンプレート — 普通の人がインポートして使えるハブ

<!-- doc-version: 1.0 -->
> **ドキュメントバージョン 1.0** · 日本語訳 · 最終更新 2026-06-27 · 権威ある原典：[English](../FLAGSHIP-TEMPLATES.md)。訳文と英語版に矛盾がある場合は、英語版が優先されます。

> これは**保証済み**テンプレートリストです。「フラッグシップ」は「最高」を意味するのではなく、「私たちが保証する」を意味します: それぞれが**決定論的なデモ**（ワンコマンド、キー不要、自分の動作を自己アサート）を同梱し、それぞれが**ガバナンスポジション**（何に触れられるか、何に触れられないか、どこで人間がゲートするか）を公開し、それぞれが**メンテナンスされています**。
>
> すべてのテンプレート（コミュニティティアを含む）を見たいですか? 管理 UI の「ワークフロー → テンプレートギャラリー」。自分でサブミットしたいですか: [`templates/community/templates/`](../../templates/community/templates/)。このリストの選定基準は [`GOVERNANCE.md`](../../GOVERNANCE.md) に記載されています。

---

## なぜこれらか

AipeHub の差別化要因は「AI を呼び出せる」ことではありません — それはどこにでもあります。それは**AI を自宅、家族、お金に向ける勇気が持てる**ことです。なぜなら境界は本物であり、あなたのものだからです:

- **重要なアクションで人間がゲートします。** 可逆のもの（電気を消す）はただ行われます; 不可逆のもの（ドアをロックする、お金を使う、子供のデータを送信する）は一時停止し、人間がインボックスで確認するのを待ちます — ワークフローはそのゲートを**スキップできません**。
- **キーとデータはあなた自身のディスク上にあります。** クレデンシャルはあなたの `.aipehub/` ディレクトリに暗号化されています。別のハブとフェデレーションすると**能力**が共有されますが、あなたの Vault は共有されません。
- **ブラックボックスの決定なし。** すべてのディスパッチと結果は読み取り可能な読み取り専用トランスクリプトです。フレームワークはモデルを実行しません; 隠された判断はありません。

以下の各テンプレートは、これら 3 つの原則を**具体的な 1 つのことに落とし込んだ**ものです。

---

## 概要

| テンプレート | 対象 | 人間がゲートする場所（ガバナンスポジション） | 実行方法（キー不要） |
|---|---|---|---|
| **smart-home-hub** スマートホーム | スマートホームデバイスを持つ人 | 照明/エアコンは直接実行; **ドアをロック、セキュリティ設定**は居住者のインボックス確認を待つ | `pnpm demo:smart-home-hub` |
| **family-learning-hub** 家族学習 | 子供のために AI を開く親 | ホワイトリスト外のトピックと子供のデータ送信は**どちらも親の承認が必要**; サブスクリプションとデータはそれぞれ手元に留まる | `pnpm demo:family-learning-hub` |
| **cafe-ops** 店舗運営 | 小さな店のオーナー / マネージャー | 残業代: **アシスタントは提案するだけ、マネージャーがお金を決める**; スケジュールはマネージャーの確認が必要 | `pnpm demo:cafe-ops` |
| **personal-coding-hub** 個人コーディング | AI にコードを書いてもらいたい人 | 危険なコマンド（rm -rf / push --force）はあなたの承認のために一時停止; 分業はあなたが決める | `pnpm demo:personal-coding-hub` |
| **codex-deepseek-hub** コーディング（Codex + DeepSeek） | 同上、異なるモデルセット | 同上 | `pnpm demo:codex-deepseek-hub` |
| **personal-research-hub** 個人研究 | 大量の資料を整理したい人 | 読み取り専用のコンパイル、生の資料を相互リンクされた wiki に変換 | `pnpm demo:personal-research-hub` |
| **battle-monk-training** 個人成長 | 毎日のトレーニングプランが欲しい人 | 自分の成長記録のみ書き込む; 医療/心理的アドバイスは提供しない | `pnpm demo:battle-monk-training` |
| **warband-club** 趣味クラブ | 同好会 / 戦団 | 共有アーカイブは誰でも読み書き可能; 重要な決定はリーダーの確認を経る | `pnpm demo:warband-club` |
| **tea-supply-link** 組織間サプライ | サプライヤーと取引するショップ | 注文は**組織間の境界を越える前に人間の承認が必要**; サプライヤーが金額を計算し、人間が決める | `pnpm demo:tea-supply-link` |
| **tea-chain-hq** チェーン本部 | フランチャイズ店を管理する本部 | 値下げ指令は**展開前に地域マネージャーの承認が必要**; 店は主権的な当事者であり、下部組織ではない | `pnpm demo:tea-chain-hq` |

それぞれには `pnpm demo:<name>:template` も付属しています — テンプレートファイルを読み込み、パースし、宣言されたアーキテクチャをプレビューします（サブプロセスなし、キー不要）。「テンプレートに何が入っているか、テンプレートの外側に何が住んでいるか」が分かります。

---

## ホーム & ファミリー

### ⭐ smart-home-hub — スマートホーム（小米 via Home Assistant）

**誰が / 何を。** ホームスチュワードが Home Assistant 経由で小米（または任意の HA 統合）デバイスを制御し、「おやすみルーティン」を実行します。

**触れられるもの。** 共通エリアの照明を消す、寝室のエアコンを睡眠モードに切り替える — これらは**可逆**で、直接実行されます。

**人間がゲートする場所（ガバナンスポジション）。** 玄関ドアをロックしてセキュリティを設定することは**不可逆な物理的 / セキュリティ**アクションです — このステップに到達したワークフローは**一時停止**し、居住者が `/me` インボックスで「確認」をクリックするまで実行を待ちます。拒否 → そのステップは `when:` ゲートによってスキップされます → **ドアはロックされません**（fail-closed、次のアクションをブロック、外溢なし）。これがまさに「可逆は直接実行、不可逆は人間の確認が必要」をホームに落とし込んだ姿です。

**テンプレート / フレームワーク分離。** テンプレート内のデバイス MCP 配線は `${HA_MCP_SSE_URL}` / `${HA_TOKEN}` プレースホルダーです — どの Home Assistant に接続し、どのトークンを使うかはインポート後に入力するランタイム設定です。ワークフローはケーパビリティ（`home.apply-scene` / `home.secure`）のみを名指しし、特定のデバイスは名指ししません。デバイスを変えても、家を変えても、ワークフローは一言も変わりません。このテンプレートには **KB スロットがありません**（デバイスの状態はライブの HA で、別のナレッジベースは不要）。

- 実行: `pnpm demo:smart-home-hub`（2 つのシナリオ: 承認 → ドアがロックされる; 拒否 → ドアはロックされない）
- テンプレート: [`examples/smart-home-hub/template/smart-home-hub.template.yaml`](../../examples/smart-home-hub/template/smart-home-hub.template.yaml)
- 実際の Home Assistant の配線: [README](../../examples/smart-home-hub/README.md) 参照

### ⭐ family-learning-hub — 家族学習（親が子供のために AI を開く）

**誰が / 何を。** 親が AI サブスクリプションの費用を払い、子供は**別の**ハブで学習します; 子供のハブは認可を通じて親のサブスクリプションを呼び出し、AI 導師（Matt Pocock の `/teach` を再現: まずミッションを確立する、小さな一歩、知識から技能へ、一次資料を引用する）が子供の探索を導きます。これはリストの中で**最も生産化が進んでいる**ものです（本物の ws フェデレーション + IM 監督 + 本物の DeepSeek を全部通過）。

**触れられるもの。** ホワイトリスト内のトピックでは、導師が直接教えます; 学習記録の**主副本**は子供のハブにあります。

**人間がゲートする場所（ガバナンスポジション）— 4 つのゲート。**

1. **トピックホワイトリスト + コンテンツ自己評価** → ホワイトリスト外のトピック、および導師が `flagged` と自己評価したコンテンツは**親の承認のために一時停止**します。
2. **データ分類ゲート**: 子供のデータは `child-learning` とタグ付けされ、そのデータクラスが許可されていないサードパーティには送信できません（fail-closed）。
3. **管轄**: 親がサブスクリプションを保持（経済的なチョークポイント）+ フェデレーションリンクごとの信頼契約 + 全体を通じたトランスクリプトフォーク（親が監督コピーを受け取る）。
4. **クレデンシャル / データはそれぞれ手元に**: 2 つの主権ハブ、子供のデータは子供側から親にコピーを送りますが、サブスクリプションと Vault は越境しません。

**テンプレート / フレームワーク分離。** 組織間リンク（どの子供のピア、どのケーパビリティが出站許可されているか、承認ポリシー、`allowedDataClasses`）はテンプレートにもワークフローにも入っておらず、**ランタイムのピア設定**です。2 つのテンプレート: 親側 `family-tutor`（導師 + ホワイトリスト/承認ワークフロー付き）、子供側 `child-desk`（ゼロサブスクリプション + 学習記録の主副本）。

- 実行: `pnpm demo:family-learning-hub`（6 つのシナリオ: ホワイトリスト外→親が承認 / 親が拒否→授業は行われないを含む）
- テンプレート: [`family-tutor`](../../examples/family-learning-hub/template/family-tutor.template.yaml) · [`child-desk`](../../examples/family-learning-hub/template/child-desk.template.yaml)
- 本番デプロイ（2 台の主権マシン）: [`docs/zh/FAMILY-LEARNING-GO-LIVE.md`](../zh/FAMILY-LEARNING-GO-LIVE.md) · 設計: [`FAMILY-LEARNING-HUB-DESIGN.md`](../zh/FAMILY-LEARNING-HUB-DESIGN.md)

---

## 個人の生産性

### personal-coding-hub — 個人コーディング（Claude Code + Codex の分業）

**誰が / 何を。** ルーティング「モデル」がタスクを分析し、あなたの配置を考慮して、Claude Code または Codex に仕事をディスパッチするかを決定します; 2 人のコーディングエージェントが 1 つの作業ディレクトリを共有し、`AGENTS.md`（仕様）+ `PROGRESS.md`（引き継ぎバトン）を通じて協働します。また**対抗的なコンサルテーション**もあります: 問題が生じたとき、複数のエージェントが一緒にコードを読み、まず盲目的に診断してから相互に質問し合い、本当の根本原因に票決で収束します。

**人間がゲートする場所（ガバナンスポジション）。** 危険なコマンド（`rm -rf`、`git push --force`、`sudo`、`curl | sh` …）は実行**前**にあなたの承認のために一時停止します; 拒否 → fail-closed、コマンドは決して実行されません。分業は**あなたが決めます**: 「これは codex に渡して」と臨機応変に指名するか、全体の分業レイヤーを大白話で変更する（OpenClaw スタイル、`routing-policy.json` に書き戻す）。

**テンプレート / フレームワーク分離。** テンプレートは 1 つのメンターエージェント（`coding-mentor`、DeepSeek + インライン mcp-obsidian）+ 1 つのアドレス可能な KB スロット（方法論ライブラリ、`presetData` ポインター）を運びます。2 つの CLI コーディングエージェントは**ランタイムに配線されます**（CliParticipant は管理エージェントロスターに入りません）; 知識**コンテンツ**はテンプレートの外に住みます。

- 実行: `pnpm demo:personal-coding-hub`（10 シナリオ: 分業 / 明示的な割り当て / 大白話での再分業 / 安全ゲート）
- コンサルテーション: `pnpm demo:personal-coding-hub:consult`
- テンプレート: [`examples/personal-coding-hub/template/personal-coding-hub.template.yaml`](../../examples/personal-coding-hub/template/personal-coding-hub.template.yaml)

### codex-deepseek-hub — コーディング（Codex + DeepSeek TUI）

personal-coding-hub の**姊妹**: 異なるモデルセット — Codex（素早い実装者）+ DeepSeek TUI（推論リード）。同じルーティング + 大白話での再分業 + 明示的な割り当て + 安全ゲートで、独立していて personal-coding-hub には触れません。

- 実行: `pnpm demo:codex-deepseek-hub`
- テンプレート: [`examples/codex-deepseek-hub/template/codex-deepseek-hub.template.yaml`](../../examples/codex-deepseek-hub/template/codex-deepseek-hub.template.yaml)

### personal-research-hub — 個人研究 / ナレッジハブ

**誰が / 何を。** 司書があなたの生の資料を相互リンクされた Obsidian wiki に**コンパイル**し（LLM-as-compiler）、次に「wiki に質問」できるようにします。3 つの管理 LLM エージェント（司書 / コンパイラー / 研究者）がチームとして動きます。

**ガバナンスポジション。** コンパイルは生のものをノート + バックリンクに変換する**読み取り専用**の作業です; 回答はソースを引用し、`wiki/answers/` にアーカイブします。

- 実行: `pnpm demo:personal-research-hub`
- テンプレート: [`examples/personal-research-hub/template/personal-research-hub.template.yaml`](../../examples/personal-research-hub/template/personal-research-hub.template.yaml)

### battle-monk-training — 個人成長（身体 / 精神 / 学識、三本柱）

**誰が / 何を。** 督修が今日のトレーニングを三本柱（身体 / 精神 / 学識）にディスパッチし、それぞれがあなたの記録にすでに練った段位に基づいて次の段位に進みます。継続性が設計の核です — Obsidian KB が**あなたの状態を保存**します（参考資料ではなく）。冷たい grimdark-monastic スタイル（オリジナルのファン向けトリビュート、Warhammer 40k スタイルのユーザー向け）。

**ガバナンスポジション / 安全境界。** **自分の成長記録のみ書き込みます**; これは個人データであり、**医療 / 心理的アドバイスではありません** — それだけを唯一の根拠として扱わないでください。

- 実行: `pnpm demo:battle-monk-training`
- テンプレート: [`examples/battle-monk-training/template/battle-monk-training.template.yaml`](../../examples/battle-monk-training/template/battle-monk-training.template.yaml)

---

## 組織 & 組織間

### cafe-ops — 店舗運営（タピオカミルクティー / カフェ）

**誰が / 何を。** 小さな店の正式なプロセス: 新入社員オンボーディング（ポジション SOP の学習、メンバー自助）、スケジュール管理（マネージャー確認）、残業代（マネージャー承認）。空でない `workflows[]` を持つ最初のテンプレート — 組織の価値は正式なプロセスにあります。

**人間がゲートする場所（ガバナンスポジション）。** 残業代: **アシスタントは金額を提案するだけ、マネージャーがお金を決めます**: アシスタントは日種別に倍率を計算しますが（平日 1.5 / 休日 2 / 法定祝日 3）、ワークフローは承認ステップに到達すると一時停止し、マネージャーがインボックスで承認した後にのみ実行されます。**お金は決定論的に計算され、LLM ではありません; 人間が決めます。**

- 実行: `pnpm demo:cafe-ops`（残業代 HITL の二段階再開を含む）
- テンプレート: [`examples/cafe-ops/template/cafe-ops.template.yaml`](../../examples/cafe-ops/template/cafe-ops.template.yaml)

### warband-club — 趣味クラブ（共有アーカイブ）

**誰が / 何を。** 同好会 / 戦団の**協働面**（cafe-ops の管理面に対して）: グループ全員が読み書きする共有アーカイブ — あなたが提出した塗装方案 / 戦況報告、他の人が調べられます; あなたが得た答えは他の誰かの以前の貢献から来るかもしれません = 協働です。

**ガバナンスポジション。** 共有アーカイブは誰でも読み書き可能です; 重要な決定（集結）はリーダーの `human:` 確認を経ます。1 つのハブ内での共有で、フェデレーションなし。

- 実行: `pnpm demo:warband-club`
- テンプレート: [`examples/warband-club/template/warband-club.template.yaml`](../../examples/warband-club/template/warband-club.template.yaml)

### tea-supply-link — 組織間サプライ（茶店 ↔ サプライヤー）

**誰が / 何を。** 最初の**組織間**テンプレート: 茶店の補充ワークフローが 1 ステップを**サプライヤーのハブ**に編成します。

**人間がゲートする場所（ガバナンスポジション）。** 組織間の注文ステップは**出站承認ゲート**を通ります（ワークフローに対して透明なので、ワークフローには `human:` ステップが**ありません**）— マネージャーが承認した後にのみ境界を越え、サプライヤーがカタログ + 在庫でラインごとに価格を設定し、レシートがローカルにファイルされるために流れ戻ります。サプライヤーがお金を計算し、人間が送信を決めます。

**テンプレート / フレームワーク分離（教育ポイント）。** 組織間リンク（どのピアがサプライヤーか、どのケーパビリティが出站許可されているか、承認ポリシー）はテンプレートにもワークフローにも入っておらず、**ランタイムのピア設定**です — `place` ステップはケーパビリティ `supplier.confirm-order` のみを書き、ピアを名指ししません。

- 実行: `pnpm demo:tea-supply-link`
- テンプレート（店側）: [`examples/tea-supply-link/template/tea-shop.template.yaml`](../../examples/tea-supply-link/template/tea-shop.template.yaml)
- 2 台のオペレーターランブック: [`docs/zh/FEDERATION-RUNBOOK.md`](../FEDERATION-RUNBOOK.md)

### tea-chain-hq — チェーン本部（本部 → フランチャイズ店）

**誰が / 何を。** tea-supply-link の**ミラー、逆方向**: そちらは上へ（店→サプライヤー）、これは下へ（本部→フランチャイズ店）。三層チェーン `本部 → 店 → サプライヤー` で、店は中間にいます。

**人間がゲートする場所（ガバナンスポジション）。** 値下げ指令を展開する組織間ステップは出站承認ゲートを通ります — 地域マネージャーが承認した後にのみ境界を越え、店が自分のメニューに従って決定論的に値下げを適用し、レシートが流れ戻ります。**店は主権的な組織であり、下部組織ではありません。**

- 実行: `pnpm demo:tea-chain-hq`
- テンプレート（本部側）: [`examples/tea-chain-hq/template/chain-hq.template.yaml`](../../examples/tea-chain-hq/template/chain-hq.template.yaml)

---

## ワンコマンドで任意のものを実行する（決定論的、キー不要）

各フラッグシップには**決定論的なデモ**があります: 決定論的な代替エージェントでフロー全体を実行し、自分の動作をアサートします。API キー不要、実際のデバイス / 実際のアカウント不要。これが「私たちが保証する」の検証可能な半分です — ワンコマンドで本当に動くことを証明します:

```bash
pnpm demo:smart-home-hub          # ホーム: 承認→ドアがロックされる / 拒否→ドアはロックされない
pnpm demo:family-learning-hub     # 家族: ホワイトリスト外→親が承認 / 親が拒否→授業は行われない
pnpm demo:cafe-ops                # 店舗: 残業代 HITL、マネージャーがお金を決める
pnpm demo:personal-coding-hub     # コーディング: 分業 + 安全ゲート
pnpm demo:personal-research-hub   # 研究: 生の資料 → 相互リンクされた wiki
pnpm demo:battle-monk-training    # 成長: 身体/精神/学識 三本柱
pnpm demo:warband-club            # クラブ: 共有アーカイブ + リーダー確認
pnpm demo:tea-supply-link         # 組織間: 境界を越える注文には人間の承認が必要
pnpm demo:tea-chain-hq            # チェーン: 値下げ展開には人間の承認が必要
pnpm demo:codex-deepseek-hub      # コーディング（Codex + DeepSeek）
```

テンプレート自体がどのようにパースされるかを見るには（ロードプレビュー、こちらもキー不要）: 上記のいずれかを `pnpm demo:<name>:template` に置き換えてください。

---

## 実際に使う

決定論的なデモはロジックが動くことを証明します; フラッグシップを実際に使うには、次のルートを取ります:

- **ワンクリックインストール**: 管理 UI の「ワークフロー → テンプレートギャラリー」でクリックするだけでハブにインストールされます（[`docs/zh/TEMPLATE-GALLERY.md`](../zh/TEMPLATE-GALLERY.md) 参照）。
- **個人 / 組織ハブの比較 + 本物の DeepSeek/Obsidian オンボーディング**: [`docs/zh/HANDS-ON-HUBS.md`](../zh/HANDS-ON-HUBS.md)。
- **ゴーライブ（3 つのトポロジー）**: [`docs/zh/GO-LIVE.md`](../zh/GO-LIVE.md)。
- **組織間フェデレーション 2 台オペレーターランブック**: [`docs/zh/FEDERATION-RUNBOOK.md`](../FEDERATION-RUNBOOK.md)。
- **家族学習 2 台主権マシンデプロイ**: [`docs/zh/FAMILY-LEARNING-GO-LIVE.md`](../zh/FAMILY-LEARNING-GO-LIVE.md)。

---

## 引用ランキング（誰が最も多く適応したか）

正直な来歴はこのコミュニティの唯一の通貨です。テンプレートをフォークするときは、そのスラッグを `provenance.derivedFrom` に書いてください — そしてクレジットが上流に流れます。以下の表は「何個のテンプレートが `derivedFrom` に自分を宣言しているか」でランク付けされており（引用数 = 入次数）、検証済みテンプレートコーパスから [`pnpm build:leaderboard`](../../packages/web/scripts/build-leaderboard-doc.mjs) によって**決定論的に生成**されます。[静的ストアフロント](../COMMUNITY-SITE.md) のランキングと同じ計算で（決して矛盾しません）:

> 注: ランキングジェネレーターは現在、マーカーを中国語ソース（[`docs/zh/FLAGSHIP-TEMPLATES.md`](../zh/FLAGSHIP-TEMPLATES.md)）に書き込みます。以下のスナップショットはその生成されたテーブルの手動ミラーです; ジェネレーターをこの英語ドキュメントをターゲットにするよう再配線することは追跡中のフォローアップです。

| # | テンプレート | 引用数 | 適応したもの |
|---|---|---|---|
| 1 | **個人コーディングメンター（Karpathy ワークフロー）** (`personal-coding-hub`) | 1 | ペアリングコーディングメンター（Codex × DeepSeek TUI） |
| 2 | **茶店（組織間サプライリンク）** (`tea-supply-link`) | 1 | 茶チェーン本部（組織間指令展開） |

> テーブルは**生成**されます: `derivedFrom` エッジを追加した後は、`pnpm build:leaderboard` を実行してソースを再レンダリングしてください。`packages/web/tests/build-leaderboard-doc.test.ts` がそれが本物のコーパスと同期していることを監視します — 手動編集や再レンダリングを忘れるとテストで検出されます。ランキングは**人ではなくテンプレートを**ランク付けします — これは**表彰**のインセンティブであり、報酬や経済的なものではありません（[`docs/zh/RECOGNITION-SYSTEM.md`](../zh/RECOGNITION-SYSTEM.md) / [`RECOGNITION-SYSTEM.md`](../RECOGNITION-SYSTEM.md) 参照）。

---

## 貢献したいなら

フラッグシップは少数で保証済みです。テンプレートの大多数は**コミュニティティア**であるべきです — バーは「ライセンスクリア、パース可能、平文シークレットなし、来歴あり」であり、「私たちがあなたの趣味を保証する」ではありません。フローは [`templates/community/templates/README.md`](../../templates/community/templates/README.md) にあります: フラッグシップをコピー → 自分のものに適応 → 来歴を宣言（`derivedFrom`）→ ローカルで `pnpm check:templates` → PR を開く。

正直な来歴はこのコミュニティの通貨です: `derivedFrom` がクレジットを上流に流し、静的引用ランキングは単に「何個のテンプレートがあなたから派生しているか」を数えます。コミュニティティアからフラッグシップへの昇格はパブリックな Issue でのメンテナーの決定です — 基準は [`GOVERNANCE.md`](../../GOVERNANCE.md) にあります。
