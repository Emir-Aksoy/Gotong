# コミュニティランディングページ + テンプレートギャラリー + 引用ランキング（ゼロコンピュートの静的サイト）

<!-- doc-version: 1.0 -->
> **ドキュメントバージョン 1.0** · 日本語訳 · 最終更新 2026-06-27 · 権威ある原典：[English](../COMMUNITY-SITE.md)。訳文と英語版に矛盾がある場合は、英語版が優先されます。

> プレローンチチェックリスト項目 7。一行で: **コミュニティはゼロコンピュートが必要** — 静的ファイルの山として構築し、任意の無料静的ホストにデプロイすれば公開される; クラウドボックスはバックアップとして保持。

---

## 1. なぜ「ゼロコンピュート」か

Gotong の設計スタンス全体は **ハブは自らが LLM を実行しない / 状態はすべてディスクファイル / クレデンシャルはあなたのマシンに留まる / フェデレーションはピアツーピア** です。このスタンスを貫くと、**コミュニティインフラもサーバーを必要としません**:

- **GitHub がすでに実体をホストしている** — テンプレートはファイル、サブミッションは PR です。
- **唯一欠けているのはストアフロント** — ファイルファーストプロジェクトのストアフロントはそれ自体が静的ファイルの山です。

つまりこのストアフロント = 1 つのジェネレーター + 生成される静的ファイルです。ジェネレーターは [`packages/web/scripts/build-site.mjs`](../../packages/web/scripts/build-site.mjs) で、`site/`（リポジトリルート、`.gitignore` 済み）を生成します:

- `index.html` — 自己完結した単一ファイル（フレームワークなし、ランタイムなし、CSS インライン）: 信頼ナラティブのヒーロー + テンプレートギャラリーカードグリッド + 引用ランキングテーブル。
- `templates.json` — 機械可読な `gotong.site/v1` フィード（ストアフロントはデータでもあり、ファイルファースト）。

`site/` を GitHub Pages / Cloudflare Pages / Netlify の任意の無料ティアにドロップすれば、**$0** でストアフロントが公開されます。腾讯云 2c2G ボックスはバックアップとしてアイドリングを継続します。

---

## 2. ビルド方法

```bash
pnpm build:site          # ルートスクリプト、packages/web に委譲
# または
pnpm -C packages/web build:site
```

出力:

```
build-site: 11 templates → site/ (index.html + templates.json), 2 on the leaderboard
```

`site/` は**必要に応じてビルドされ、チェックインされない**派生アーティファクトです（`dist-portable/` と同じスタンス、`.gitignore` 参照）。信頼の単一ソースは `examples/` と `templates/community/` に留まります（テンプレート/フレームワーク分離）; ストアフロントはその読み取り専用プロジェクションです — テンプレートを変更してジェネレーターを再実行してください。

**決定論**: ジェネレーターはタイムスタンプを書かず、安定してソートします → 同じ入力で**バイト単位で同一**の `site/` が生成されるため、再ビルドが無意味な差分を生成しません。

---

## 3. コーパス = 検証済みと同じセット

ジェネレーターは、リポジトリレベルの検証ゲート（`pnpm check:templates` / [`tests/all-templates-parse.test.ts`](../../packages/web/tests/all-templates-parse.test.ts)）が検証するのと**まったく同じ** 2 つのルートをスキャンします:

| 起源 | パス | 備考 |
|---|---|---|
| `flagship` | `examples/*/template/*.template.ya?ml` | フレームワークに同梱のフラッグシップテンプレート |
| `community` | `templates/community/templates/**/*.ya?ml` | コミュニティのサブミッションが届く場所 |

つまり「CI を通過したすべてのテンプレートがストアフロントに表示される」は**構造的に**成立します — パースできないマニフェストはカードに到達できません（`check:templates` で失敗し、取り込まれることはありません）。

---

## 4. 引用ランキング = `provenance.derivedFrom` の入次数

ランキングは加算的な来歴フィールド `template.provenance.derivedFrom` を読みます（プレローンチチェックリスト項目 6）:

- 1 つの `derivedFrom` エントリは 1 つの**引用エッジ**: 「このテンプレートは誰かから適応した」と宣言します。
- ランキング = **入次数** = 「何個のテンプレートが私から派生しているか」。
- エッジはターゲットテンプレートの**スラッグ**（パブリックハンドル、下記参照）を参照するため、テンプレートをフォークするときに `provenance.derivedFrom` に**上流のスラッグ**を書けば帰属の系譜が完成します。

フレームワークに同梱されている 2 つの本物の引用エッジ（`CLAUDE.md` にも記録されています）:

```yaml
# examples/codex-deepseek-hub/template/codex-deepseek-hub.template.yaml
provenance:
  derivedFrom: [personal-coding-hub]   # 姊妹例、同じディスパッチスケルトン

# examples/tea-chain-hq/template/chain-hq.template.yaml
provenance:
  derivedFrom: [tea-supply-link]       # MIRROR、逆方向のクロスオーグ編成
```

→ ランキングでは `personal-coding-hub` と `tea-supply-link` がそれぞれ 1 票を得ます。

**タイポは静かに飲み込まれません**: `derivedFrom` が存在しないスラッグを指している場合、ジェネレーターは stderr に `WARNING … no template with that slug` を出力します（`buildModel` は `unresolved` に収集）、静かに 0 票としてスキップすることはありません。

---

## 5. スラッグ（パブリックハンドル）のスキーム

スラッグはテンプレートの**安定したパブリック ID** です — ギャラリー（`builtin-templates.ts`）、`FLAGSHIP-TEMPLATES.md`、このストアフロントが同じハンドルを使うため、フォークの `derivedFrom` が「誰もが知る名前」で上流を参照できます。`assignSlugs` のルール:

| ソース | スラッグ |
|---|---|
| フラッグシップ、`examples/<dir>` 下にテンプレートファイルが**ちょうど 1 つ** | `<dir>` のベース名（例: `examples/tea-supply-link` が `tea-shop.template.yaml` を保持 → スラッグ `tea-supply-link`、**ファイル名ではない**） |
| フラッグシップ、同じ dir 下に**複数の**テンプレートファイル | ファイル名ステムで曖昧さを解消（例: `examples/family-learning-hub` が `family-tutor` + `child-desk` を保持） |
| コミュニティ | ファイル名ステム |

**コンフリクトはビルドの失敗**: 同じスラッグを計算する 2 つのテンプレート → `assignSlugs` がスローします。曖昧なパブリックハンドルはビルド時に大きな音を立てて失敗しなければならず、静かに上書きされたカード / 間違ったテンプレートを指すエッジになってはいけません。（この一意性ガードは実際に踏んだ落とし穴です: `family-tutor` と `child-desk` は同じ dir にあり、以前は両方が dir 名 `family-learning-hub` を取得して衝突しました。）

---

## 6. デプロイ（無料静的ホスティング）

`site/` は純粋な静的アーティファクトです; 任意の無料ティアが機能します。**GitHub Pages** を例に挙げます（Actions クォータは不要 — ローカルでビルドし、`gh-pages` ブランチに手動でプッシュするか Pages の `/docs` 規約を使用）:

```bash
pnpm build:site
# その後、site/ の内容を選択した静的ホストに公開します:
#   · Cloudflare Pages / Netlify: site/ をドラッグ＆ドロップするか、"build: pnpm build:site,
#     output: site" フックを設定（彼らの無料ティアは独自のビルドクォータを持ち、このリポジトリの Actions クォータとは無関係）;
#   · GitHub Pages: ローカルでビルドしてから site/ を gh-pages ブランチにプッシュ。
```

> ⚠️ このリポジトリの **GitHub Actions クォータは使い果たしている**ため、ストアのビルドはこのリポジトリの CI に依存**しません**。ジェネレーターはローカルで実行されます（無料）; 静的ホストの独自のビルドクォータは別の問題です。`site/` はチェックインされていないため、リポジトリの膨張を招きません。

---

## 7. アンチロットテスト

[`tests/build-site.test.ts`](../../packages/web/tests/build-site.test.ts) はジェネレーターの純粋なロジックをピン留めします（その IO シェルはガードされているため、`import` はファイルスキャンをトリガーせず、ファイルを書き込みません）:

- `assignSlugs` — 3 つのスラッグルール + 一意性ガード（実際の落とし穴のリグレッションフェンス）;
- `extractTemplate` — 未加工のマニフェストから表示サーフェス + `provenance.derivedFrom`（空のエントリをフィルタリング）を読み取り、不正なスキーマで大きな音を立ててスロー;
- `buildModel` — 引用の入次数カウント + ランキングソート + タイポの参照を `unresolved` として表面化;
- `escapeHtml` / `render*` — コミュニティが提供する名前 / 説明は**信頼できない**ため、XSS ケースが `<script>` がマークアップから決してエスケープできないことをピン留め。

---

## 8. 境界（正直に）

- ストアフロントはテンプレートエディターでも、何かをインストールするものでもありません — 読み取り専用の表示ウィンドウです。インストールは管理コンソールの「テンプレートギャラリー」ワンクリックインストール / `POST /api/admin/templates/import` を通じて行われます（[`TEMPLATE-GALLERY.md`](../zh/TEMPLATE-GALLERY.md) 参照）。
- **テンプレート/フレームワーク分離**は破られません: ストアフロントはマニフェストの**構造 + 参照**のみを読み取り、知識コンテンツや人員を表示 / 運搬することはありません（決定 #4/#5）。
- `site/` はビルド時のスナップショットです: `examples/*/template/` を変更するかコミュニティテンプレートを追加した後は、**`pnpm build:site` を再実行する**必要があります; アンチロットテストがそのセンチネルです。

---

## 関連資料

- [`TEMPLATE-GALLERY.md`](../zh/TEMPLATE-GALLERY.md) — 管理コンソール内のワンクリックインストールギャラリー（同じコーパスの別のコンシューマー）。
- [`FLAGSHIP-TEMPLATES.md`](../FLAGSHIP-TEMPLATES.md) — フラッグシップテンプレートのキュレーションインデックス。
- [`HANDS-ON-HUBS.md`](../zh/HANDS-ON-HUBS.md) — すぐに使えるハブ例の比較 + ゴーライブランブック。
- `../../CONTRIBUTING.md` — コミュニティテンプレートサブミッションフロー（ライセンスクリア + `pnpm check:templates` 通過）。
