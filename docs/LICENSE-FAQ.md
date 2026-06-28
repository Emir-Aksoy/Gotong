# License FAQ

<!-- doc-version: 1.0 -->
> **Doc version 1.0** · English (authoritative source) · Updated 2026-06-27 · Translations: [中文](zh/LICENSE-FAQ.md) · [日本語](ja/LICENSE-FAQ.md) · [Русский](ru/LICENSE-FAQ.md) · [Français](fr/LICENSE-FAQ.md) · [Español](es/LICENSE-FAQ.md) · [한국어](ko/LICENSE-FAQ.md). If a translation conflicts with this English version, the English version governs.

> **AipeHub as a whole is licensed under the [MIT License](../LICENSE).**
> This page answers the common "may I / must I / what should I watch
> for" questions in FAQ form. It is not legal advice — for real
> corporate compliance work, talk to your own counsel.
>
> 中文版见 [`docs/zh/LICENSE-FAQ.md`](zh/LICENSE-FAQ.md)。

---

## 1. Can I embed AipeHub in my closed-source product / SaaS / internal tool?

**Yes.** MIT is among the most permissive OSS licenses. It allows:

- ✅ Commercial use, including repackaging all of AipeHub and selling it
- ✅ Modifying the source, renaming it (though if you rename, please say "based on AipeHub")
- ✅ Closed-source derivatives — your changes do **not** have to be open-sourced
- ✅ Pulling `@aipehub/core` into a closed-source SaaS as an npm dependency

**The only hard requirement**: keep the LICENSE file + copyright
notice (listing AipeHub on your product's NOTICE /
Third-Party-Licenses page is enough).

---

## 2. I modified the source — must I contribute the changes back?

**No.** MIT is not copyleft. You may:

- Keep your modifications private
- Ship them as part of a commercial product
- Never send a PR upstream — that's completely fine

That said, we welcome PRs — the better the project gets, the
cheaper your next upgrade. See [`CONTRIBUTING.md`](../CONTRIBUTING.md)
for the process.

---

## 3. What should I watch for when using the third-party prompt templates in `templates/community/` commercially?

`templates/community/` collects two upstream sources:

| Source | License | Commercial use | Note |
|---|---|---|---|
| [`awesome-chatgpt-prompts`](https://github.com/f/awesome-chatgpt-prompts) | **CC0 1.0** (public domain) | ✅ any use | Attribution is legally **not required**; we keep the source line out of respect |
| [`awesome-chatgpt-prompts-zh`](https://github.com/PlexPt/awesome-chatgpt-prompts-zh) | **MIT** | ✅ any use | You **must keep** the copyright + license notice |

How is the notice kept? `templates/community/` already carries it at
three layers:

1. A **4-line header comment** in every yaml file: `# Source` /
   `# Upstream` / `# License` / `# Adapted`
2. The aggregate file
   [`templates/community/LICENSE-NOTICES.md`](../templates/community/LICENSE-NOTICES.md)
   keeps the full MIT text + a CC0 summary + upstream repo URLs
3. The directory's [`README.md`](../templates/community/README.md)
   explains the adaptation rules and the license matrix

As long as you redistribute `templates/community/` **with those three
layers intact** (git fork / cloud raw URL / internal CDN — all fine),
you are fully compliant.

> "I pasted a template's content into the admin UI and it landed in my
> `secrets.enc.json` / `agents.json` — is that distribution?" —
> **No.** You are merely using it inside your own deployment, not
> conveying it to third parties. No attribution action is needed.

---

## 4. Can I change the LICENSE and re-release this as "our" product?

You may **change the product name and add your own license line**,
but you may **not delete the original MIT text**:

- ✅ Your derivative can be called `BobHub`, and can be Apache-2.0 /
  proprietary / something you wrote yourself
- ✅ You can put your own copyright in your own LICENSE file
- ⚠️ But you **must keep, somewhere** (e.g. NOTICE.md or
  THIRD-PARTY.md), AipeHub's original MIT text + upstream copyright line
- ❌ You may **not** claim "AipeHub is our original work" — that's
  fraud, regardless of the license

---

## 5. I imported a private prompt a coworker wrote with GPT as an agent — any license risk?

**None on the AipeHub side.** Prompts you or your company write are
your company's own assets; AipeHub is just the runtime container.
You should however confirm:

- Whether your coworker's GPT output complies with OpenAI's terms of
  service (OpenAI's policy on "ownership" of model output has varied
  over time — ask legal)
- If the prompt **quotes** someone else's code / article excerpts,
  whether that quotation's own license allows it

Neither is something the AipeHub project governs — MIT licenses the
software itself, not the content you generate with it.

---

## 6. I'm deploying AipeHub inside a customer's intranet — what license files do I hand over?

At minimum:

- The `LICENSE` file from the AipeHub repo root
- If you use `templates/community/`: bring `LICENSE-NOTICES.md` along too
- If you embed the `@aipehub/core` npm package: the package ships its
  own license on install; downstream redistribution just needs to keep
  `node_modules/@aipehub/*/LICENSE` undeleted

A common pattern is a "Third-Party Licenses" page in your product
listing every upstream OSS license text. Add AipeHub's MIT there and
you're done.

---

## 7. Do AipeHub's runtime dependencies contain GPL/AGPL-style copyleft?

Currently no. The main dependencies:

| Dependency | License |
|---|---|
| `ws` (WebSocket) | MIT |
| `yaml` | ISC |
| `better-sqlite3` (optional) | MIT |
| `@anthropic-ai/sdk` (optional peer dep) | MIT |
| `openai` (optional peer dep) | Apache-2.0 |
| `vitest` (dev only) | MIT |
| `tsx` (dev only) | MIT |

All permissive. If a GPL/AGPL dependency were ever proposed we'd open
an issue first; our bias is to **avoid** copyleft dependencies to keep
downstream flexibility.

---

## 8. Is AipeHub's wire protocol part of the license?

No. The JSON frame format described in `docs/PROTOCOL.md` is a
**de-facto spec** — anyone may implement their own hub server or SDK
**without any permission**. We encourage language-ecosystem ports
(Go / Rust / browser SDKs etc.); each picks its own license.

---

## 9. How do I report a vulnerability?

Via **GitHub Security Advisory** (private submission) on the project
repository — that is the only security channel; there is deliberately
no security email (see [`SECURITY.md`](../SECURITY.md)). Posting
vulnerability details in a public issue is **not okay** — even though
the license would allow it.

---

## 10. Can my company fork AipeHub internally without open-sourcing the fork?

**Absolutely.** MIT does not propagate. You may:

- Fork into your private Git → modify freely → deploy on the intranet
- Rename the fork and deploy it privately for customers
- Sell the fork's build artifacts as a closed-source binary

As long as **the final deliverable keeps AipeHub's original MIT
license somewhere** (typically an "open-source notices" page), you're
all set.

---

## TL;DR

> "**Just use it.**" — 99 % of ordinary use needs no extra action
> beyond keeping the LICENSE file + copyright line.
> `templates/community/` adds one step: keep `LICENSE-NOTICES.md`.
> Everything else only triggers when you do one of the special things
> above.

> Still unsure? Open a GitHub Discussion and we'll do our best;
> for actual compliance calls, ask your company's counsel.
