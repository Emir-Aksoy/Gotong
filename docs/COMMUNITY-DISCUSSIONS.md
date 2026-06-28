# GitHub Discussions — the community "living room" (zero compute, one-time enable)

<!-- doc-version: 1.0 -->
> **Doc version 1.0** · English (authoritative source) · Updated 2026-06-27 · Translations: [中文](zh/COMMUNITY-DISCUSSIONS.md) · [日本語](ja/COMMUNITY-DISCUSSIONS.md) · [Русский](ru/COMMUNITY-DISCUSSIONS.md) · [Français](fr/COMMUNITY-DISCUSSIONS.md) · [Español](es/COMMUNITY-DISCUSSIONS.md) · [한국어](ko/COMMUNITY-DISCUSSIONS.md). If a translation conflicts with this English version, the English version governs.

> Pre-launch checklist item 8. One line: **Issues are the ticket desk, Discussions are the living room** — asking questions, showing off results, and pitching ideas all happen here; GitHub hosts it for free, **zero compute** just like the landing page/leaderboard.

---

## 1. Why Discussions (and not yet another service)

Same stance as [`COMMUNITY-SITE.md`](COMMUNITY-SITE.md): for a file-first project whose hub doesn't run the LLM itself, **the community infrastructure shouldn't need a server either**. GitHub Discussions hosts the entire "living room" — threads, categories, @mentions, Markdown, search — all GitHub's job, with not a line of backend from us.

- **Issues** = the ticket desk for "something is broken / missing" (closable, assignable, stateful).
- **Discussions** = the living room for "I want to ask / show / chat" (open-ended, votable, can mark a best answer).

These two entrances are already routed in [`.github/ISSUE_TEMPLATE/config.yml`](../.github/ISSUE_TEMPLATE/config.yml) — when opening an issue, the "💬 Question or discussion" contact link sends people to Discussions. **So before Discussions is enabled, that link is a 404**; once enabled it goes live immediately.

---

## 2. ⚠️ The only manual action: enable Discussions (Claude can't help)

**Enabling Discussions is a repo-settings toggle, not a file — neither Claude nor CI can flip it.** This step must be done by the repo owner in the web UI:

1. Open `https://github.com/Emir-Aksoy/AipeHub/settings` (repo **Settings**).
2. Scroll down to the **Features** section, check **Discussions**.
3. GitHub will **auto-create the default categories**: Announcements / General / **Ideas** / Polls / **Q&A** / **Show and tell**. The three form templates shipped with this repo (see §4) target the three bolded ones and auto-attach **the moment** you enable, with no category creation needed.

> This is what "scaffolding is ready, all that's missing is a switch" means: the template files, the welcome-post draft, the issue-routing link, and the docs are all sitting in the repo; you click Features → Discussions and the living room opens.

After enabling, two more things are recommended (all a few clicks in the web UI, optional but recommended):

- **Pin a welcome post**: post the §5 draft as a Discussion in the General category and click "Pin."
- **(Optional) add a "Templates" custom category**: if template sharing outgrows Show and tell, create a separate one; but the default Show and tell is enough at first — don't add prematurely.

---

## 3. Category map (the three that are ready with the framework)

| Category | slug | Form | What it's for |
|---|---|---|---|
| **Q&A** | `q-a` | [`q-a.yml`](../.github/DISCUSSION_TEMPLATE/q-a.yml) | Help, questions. Can mark a "best answer." |
| **Ideas** | `ideas` | [`ideas.yml`](../.github/DISCUSSION_TEMPLATE/ideas.yml) | Pitch features / directions. The form nudges alignment with the north star (hub doesn't run the LLM / file-first / peer-to-peer federation). |
| **Show and tell** | `show-and-tell` | [`show-and-tell.yml`](../.github/DISCUSSION_TEMPLATE/show-and-tell.yml) | Show off your hub / workflow / template. **Conveniently guides submitting the template into the gallery** + writing `derivedFrom` so credit flows back. |
| Announcements | `announcements` | — | Maintainers only (releases, major changes). No form. |
| General | `general` | — | The welcome post + uncategorized chatter. No form. |

**Slug = filename**: GitHub attaches the form at `.github/DISCUSSION_TEMPLATE/<slug>.yml` to the same-named category. These three slugs are default categories GitHub **auto-creates** on enable, so the templates are "out-of-box" with no need to manually create categories and match names first.

---

## 4. Form templates (`.github/DISCUSSION_TEMPLATE/`)

Same approach as [`.github/ISSUE_TEMPLATE/`](../.github/ISSUE_TEMPLATE/) — structured forms that get the poster to give helpful info up front. The three templates each have a focus:

- **`q-a.yml`** — guides giving "what you're trying to do" (not just the error) + "what you tried" + version + run mode; and pushes **bugs back to Issues, security issues to SECURITY.md** — the living room doesn't take those two.
- **`ideas.yml`** — asks "what's the problem" before "what you want," and makes the proposer **weigh the fit against the three-layer north star** themselves (anything requiring the hub to run an LLM / hide state / centralize credentials, say so honestly — not a veto, but it shapes the discussion).
- **`show-and-tell.yml`** — beyond showing results, **fronts the "can this go into the one-click gallery" guidance**: links to the [community template submit flow](../templates/community/templates/README.md), collects `slug` and `derivedFrom` (feeding the citation leaderboard), and turns the gallery's two hard rules (credentials must be `${ENV}`, no knowledge content/personnel) into checkboxes.

> Form fields are in English — consistent with the existing `.github/ISSUE_TEMPLATE/` convention; each form's intro block adds a one-line Chinese hint to accommodate Chinese-primary users. The welcome post (§5) is Chinese-first, English-second.

---

## 5. Welcome / pinned post draft (copy-paste ready)

After enabling Discussions, **copy the whole block below**, post a new Discussion in the **General** category with the title `👋 欢迎来到 AipeHub 客厅 / Welcome`, and click **Pin**. The original draft leads with Chinese (the community's primary audience) then English; reorder as suits your audience.

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

> The links in the draft above use GitHub repo-relative paths (`../../tree/main/…`, `../../blob/main/…`), which resolve correctly to repo files once pasted into a Discussion. Preview before posting to confirm no broken links.

---

## 6. How it ties into the rest

This item isn't isolated — it connects the living room to the lines the pre-launch checklist already laid down:

- **Issue routing**: the "💬 Question or discussion" link in [`ISSUE_TEMPLATE/config.yml`](../.github/ISSUE_TEMPLATE/config.yml) has long pointed at `/discussions`; once enabled, this link stops being a 404.
- **Template gallery / leaderboard**: the Show & Tell form sends template authors to the [community template submit flow](../templates/community/templates/README.md); after a submission is merged it appears in the one-click gallery ([`TEMPLATE-GALLERY.md`](zh/TEMPLATE-GALLERY.md)) and the static storefront ([`COMMUNITY-SITE.md`](COMMUNITY-SITE.md)); the `derivedFrom` the form collects feeds the citation leaderboard.
- **Governance**: [`GOVERNANCE.md`](../GOVERNANCE.md) lists Discussions as one of the contributor entrances; directions that take shape in Ideas land via GOVERNANCE's decision process.

The "Enable GitHub Discussions" item in `.github/RELEASE-CHECKLIST.md` now points to this doc.

---

## 7. Boundaries (honest)

- **Claude can't enable Discussions**: that's a toggle in repo Settings (§2), only the owner can click it in the web UI. What this repo can do — the "scaffolding": form templates, welcome-post draft, routing link, docs — is all ready.
- **Forms aren't review**: Discussion templates only **guide posting**, they don't block or validate. The real validation for a template entering the gallery is [`pnpm check:templates`](../templates/community/templates/README.md) (passing real `parseTemplate`), which is a separate matter.
- **No forced history migration**: links scattered across docs today pointing at `/discussions` (REAL-WORLD-TESTING, LICENSE-FAQ, etc.) go live naturally once enabled, with no need to go back and edit them.

---

## Related

- [`COMMUNITY-SITE.md`](COMMUNITY-SITE.md) — the zero-compute static storefront (the other half of the same stance).
- [`TEMPLATE-GALLERY.md`](zh/TEMPLATE-GALLERY.md) — the one-click install gallery inside the admin console.
- [`FLAGSHIP-TEMPLATES.md`](FLAGSHIP-TEMPLATES.md) — the flagship template curated index + citation leaderboard.
- `../CONTRIBUTING.md` · `../GOVERNANCE.md` · `../CODE_OF_CONDUCT.md` — the community root files.
- [`templates/community/templates/README.md`](../templates/community/templates/README.md) — the 5-step template submit flow.
