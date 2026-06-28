# GitHub Discussions — コミュニティの「リビングルーム」（ゼロコンピュート、一度限りの有効化）

<!-- doc-version: 1.0 -->
> **ドキュメントバージョン 1.0** · 日本語訳 · 最終更新 2026-06-27 · 権威ある原典：[English](../COMMUNITY-DISCUSSIONS.md)。訳文と英語版に矛盾がある場合は、英語版が優先されます。

> プレローンチチェックリスト項目 8。一行で: **Issues はチケットデスク、Discussions はリビングルーム** — 質問する、結果を披露する、アイデアを提案するはすべてここで行われます; GitHub が無料でホストし、ランディングページ / ランキングと同様に**ゼロコンピュート**です。

---

## 1. なぜ Discussions か（もう一つのサービスではなく）

[`COMMUNITY-SITE.md`](../COMMUNITY-SITE.md) と同じスタンスです: ハブ自身が LLM を実行しないファイルファーストプロジェクトにとって、**コミュニティインフラもサーバーを必要とすべきではありません**。GitHub Discussions がすべての「リビングルーム」をホストします — スレッド、カテゴリ、@メンション、Markdown、検索 — すべて GitHub の仕事で、私たちのバックエンドは一行もありません。

- **Issues** = 「何かが壊れている / 欠けている」のチケットデスク（クローズ可能、割り当て可能、状態あり）。
- **Discussions** = 「尋ねたい / 見せたい / 話したい」のリビングルーム（オープンエンド、投票可能、ベストアンサーをマーク可能）。

この 2 つの入口はすでに [`.github/ISSUE_TEMPLATE/config.yml`](../../.github/ISSUE_TEMPLATE/config.yml) でルーティングされています — Issue を開くと、「💬 質問またはディスカッション」の連絡先リンクが Discussions に人を誘導します。**したがって Discussions が有効化される前は、そのリンクは 404 です**; 有効化されると即座に公開されます。

---

## 2. ⚠️ 唯一の手動アクション: Discussions の有効化（Claude には手伝えません）

**Discussions の有効化はリポジトリ設定のトグルであり、ファイルではありません — Claude も CI もそれを切り替えることができません。** このステップはリポジトリオーナーが Web UI で行う必要があります:

1. `https://github.com/Emir-Aksoy/AipeHub/settings`（リポジトリ **Settings**）を開く。
2. **Features** セクションまでスクロールし、**Discussions** にチェックを入れる。
3. GitHub は**デフォルトカテゴリを自動作成します**: Announcements / General / **Ideas** / Polls / **Q&A** / **Show and tell**。このリポジトリに同梱されている 3 つのフォームテンプレート（§4 参照）は太字の 3 つをターゲットにし、カテゴリ作成を必要とせず有効化した**瞬間**に自動適用されます。

> これが「スキャフォールディングは準備完了、あとはスイッチだけ」の意味です: テンプレートファイル、ウェルカムポストの下書き、Issue ルーティングリンク、ドキュメントはすべてリポジトリに入っています; Features → Discussions をクリックすればリビングルームが開きます。

有効化後、さらに 2 つのことを推奨します（すべて Web UI で数クリック、オプションですが推奨）:

- **ウェルカムポストをピン留め**: §5 の下書きを General カテゴリのディスカッションとして投稿し、「Pin」をクリックする。
- **（オプション）「Templates」カスタムカテゴリを追加**: テンプレートの共有が Show and tell に収まらなくなったら、別のカテゴリを作成する; ただし最初はデフォルトの Show and tell で十分 — 早まって追加しないこと。

---

## 3. カテゴリマップ（フレームワークで準備済みの 3 つ）

| カテゴリ | スラッグ | フォーム | 用途 |
|---|---|---|---|
| **Q&A** | `q-a` | [`q-a.yml`](../../.github/DISCUSSION_TEMPLATE/q-a.yml) | ヘルプ、質問。「ベストアンサー」をマーク可能。 |
| **Ideas** | `ideas` | [`ideas.yml`](../../.github/DISCUSSION_TEMPLATE/ideas.yml) | 機能 / 方向性を提案。フォームは北極星との整合を促す（ハブは LLM を実行しない / ファイルファースト / ピアツーピアフェデレーション）。 |
| **Show and tell** | `show-and-tell` | [`show-and-tell.yml`](../../.github/DISCUSSION_TEMPLATE/show-and-tell.yml) | あなたのハブ / ワークフロー / テンプレートを披露。**テンプレートをギャラリーにサブミットし** `derivedFrom` を書いてクレジットが還流するよう便利に誘導。 |
| Announcements | `announcements` | — | メンテナーのみ（リリース、主要変更）。フォームなし。 |
| General | `general` | — | ウェルカムポスト + 未分類のおしゃべり。フォームなし。 |

**スラッグ = ファイル名**: GitHub は `.github/DISCUSSION_TEMPLATE/<slug>.yml` のフォームを同名のカテゴリに適用します。これら 3 つのスラッグは GitHub が有効化時に**自動作成**するデフォルトカテゴリなので、テンプレートは「すぐに使えます」— カテゴリを手動作成して名前を一致させる必要はありません。

---

## 4. フォームテンプレート（`.github/DISCUSSION_TEMPLATE/`）

[`.github/ISSUE_TEMPLATE/`](../../.github/ISSUE_TEMPLATE/) と同じアプローチ — 投稿者が事前に役立つ情報を提供するよう構造化されたフォームです。3 つのテンプレートにはそれぞれフォーカスがあります:

- **`q-a.yml`** — 「やろうとしていること」（単なるエラーではなく）+ 「試したこと」+ バージョン + 実行モードを提供するよう誘導; **バグを Issues に、セキュリティ問題を SECURITY.md に**送り返します — リビングルームはその 2 つを受け付けません。
- **`ideas.yml`** — 「何が欲しいか」の前に「何が問題か」を尋ね、提案者自身が**三層の北極星との適合を検討する**よう促します（ハブが LLM を実行する / 状態を隠す / クレデンシャルを一元化することを必要とする場合、正直に述べてください — 拒否権ではありませんが、議論の形を決めます）。
- **`show-and-tell.yml`** — 結果を披露するだけでなく、**「これをワンクリックギャラリーに入れられるか」のガイダンスを前面に出します**: [コミュニティテンプレートサブミットフロー](../../templates/community/templates/README.md) にリンクし、`slug` と `derivedFrom`（引用ランキングに反映）を収集し、ギャラリーの 2 つのハードルール（クレデンシャルは `${ENV}` でなければならない、知識コンテンツ / 人員なし）をチェックボックスにします。

> フォームのフィールドは英語 — 既存の `.github/ISSUE_TEMPLATE/` の規約に沿っています; 各フォームのイントロブロックは中国語第一ユーザーに対応するために一行の中国語ヒントを追加します。ウェルカムポスト（§5）は中国語第一、英語第二です。

---

## 5. ウェルカム / ピン留め投稿の下書き（コピー＆ペースト可能）

Discussions を有効化した後、**以下のブロック全体をコピー**し、**General** カテゴリに `👋 欢迎来到 AipeHub 客厅 / Welcome` というタイトルで新しいディスカッションを投稿し、**Pin** をクリックしてください。元の下書きは中国語（コミュニティの主な対象者）が先で、英語が後です; 対象者に合わせて順序を変えてください。

```markdown
## 👋 Welcome to the AipeHub living room

This is where the AipeHub community hangs out — ask, show, and talk shop. The map:

- **🙋 A question?** Open one in **Q&A**. Say what you're trying to do and what you
  tried; someone will help.
- **🛠 Built something?** Show it in **Show & Tell**. If it's a template others can
  import-and-run, submit it to the one-click gallery via the
  [submit flow](../../tree/main/templates/community/templates).
- **💡 An idea?** Pitch it in **Ideas**. AipeHub has a deliberate spine — aiming with
  it lands better: **the hub never runs an LLM · people and agents are the same
  Participant · state is files on disk · federation is peer-to-peer (workflows can
  cross org lines, but credentials/data/billing each stay home)**.
- **🐞 A bug?** That goes to [Issues](../../issues/new/choose), not here.
- **🔐 A security issue?** Please do **not** post it publicly — use the private
  channel in [SECURITY.md](../../blob/main/SECURITY.md).

New here? Start with the [5-minute overview](../../blob/main/docs/OVERVIEW.md) and the
[hands-on hubs](../../blob/main/docs/zh/HANDS-ON-HUBS.md). One house rule: be kind to
people, rigorous about ideas — full text in the
[Code of Conduct](../../blob/main/CODE_OF_CONDUCT.md). Have fun 🎉

---

## 👋 欢迎来到 AipeHub 客厅

这里是 AipeHub 的客厅——问问题、晒成果、聊想法的地方。先认认门:

- **🙋 有问题?** 去 **Q&A** 开一帖。说清楚你想做什么、试过什么,有人会帮你。
- **🛠 做了东西?** 去 **Show & Tell** 晒出来。如果是一个**别人能照着导入就跑**的
  模板,顺手按 [提交流程](../../tree/main/templates/community/templates) 提进一键画廊。
- **💡 有想法?** 去 **Ideas** 提。AipeHub 有一条明确的脊梁,对着它提更容易被采纳:
  **框架不跑大模型 · 人和 agent 是同一种参与者 · 状态都是磁盘文件 · 联邦点对点
  (工作流能跨边界,但凭证/数据/计费各归各家)**。
- **🐞 发现 bug?** 那个去 [Issues](../../issues/new/choose),不在这里。
- **🔐 安全问题?** **千万别**公开发——走 [SECURITY.md](../../blob/main/SECURITY.md)
  里的私密上报通道。

新来的,从这两篇开始:
- [5 分钟总览](../../blob/main/docs/zh/OVERVIEW.md) —— 一页地图看懂所有概念。
- [开箱即用的 hub 案例](../../blob/main/docs/zh/HANDS-ON-HUBS.md) —— 挑一个最像你
  需求的,5 分钟跑起来。

一条公约:对人客气、对事较真。完整版见
[行为准则](../../blob/main/CODE_OF_CONDUCT.md)。玩得开心 🎉
```

> 上記の下書きのリンクは GitHub リポジトリ相対パス（`../../tree/main/…`、`../../blob/main/…`）を使用しており、ディスカッションに貼り付けるとリポジトリファイルに正しく解決されます。投稿前にプレビューしてリンク切れがないことを確認してください。

---

## 6. 全体との連携

この項目は独立していません — リビングルームをプレローンチチェックリストがすでに敷いた線に接続します:

- **Issue ルーティング**: [`ISSUE_TEMPLATE/config.yml`](../../.github/ISSUE_TEMPLATE/config.yml) の「💬 質問またはディスカッション」リンクはずっと `/discussions` を指していました; 有効化されると、このリンクは 404 でなくなります。
- **テンプレートギャラリー / ランキング**: Show & Tell フォームはテンプレート作者を[コミュニティテンプレートサブミットフロー](../../templates/community/templates/README.md)に誘導します; サブミッションがマージされるとワンクリックギャラリー（[`TEMPLATE-GALLERY.md`](../zh/TEMPLATE-GALLERY.md)）と静的ストアフロント（[`COMMUNITY-SITE.md`](../COMMUNITY-SITE.md)）に表示されます; フォームが収集する `derivedFrom` は引用ランキングに反映されます。
- **ガバナンス**: [`GOVERNANCE.md`](../../GOVERNANCE.md) は Discussions をコントリビューターの入口の 1 つとして記載しています; Ideas で形になった方向性は GOVERNANCE の意思決定プロセスを通じて実現します。

`.github/RELEASE-CHECKLIST.md` の「GitHub Discussions を有効化」項目はこのドキュメントを指すようになりました。

---

## 7. 境界（正直に）

- **Claude は Discussions を有効化できません**: それはリポジトリ Settings のトグルで（§2）、オーナーだけが Web UI でクリックできます。このリポジトリが行える「スキャフォールディング」— フォームテンプレート、ウェルカムポストの下書き、ルーティングリンク、ドキュメント — はすべて準備済みです。
- **フォームはレビューではありません**: ディスカッションテンプレートは投稿を**ガイドする**だけで、ブロックまたは検証しません。ギャラリーに入るテンプレートの本当の検証は [`pnpm check:templates`](../../templates/community/templates/README.md)（本物の `parseTemplate` を通過）であり、別の問題です。
- **強制的な履歴移行なし**: 今日のドキュメント全体に散らばっている `/discussions` を指すリンク（REAL-WORLD-TESTING、LICENSE-FAQ など）は有効化されると自然に公開され、戻って編集する必要はありません。

---

## 関連資料

- [`COMMUNITY-SITE.md`](../COMMUNITY-SITE.md) — ゼロコンピュートの静的ストアフロント（同じスタンスのもう半分）。
- [`TEMPLATE-GALLERY.md`](../zh/TEMPLATE-GALLERY.md) — 管理コンソール内のワンクリックインストールギャラリー。
- [`FLAGSHIP-TEMPLATES.md`](../FLAGSHIP-TEMPLATES.md) — フラッグシップテンプレートのキュレーションインデックス + 引用ランキング。
- `../../CONTRIBUTING.md` · `../../GOVERNANCE.md` · `../../CODE_OF_CONDUCT.md` — コミュニティのルートファイル。
- [`templates/community/templates/README.md`](../../templates/community/templates/README.md) — 5 ステップのテンプレートサブミットフロー。
