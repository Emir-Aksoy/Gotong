# GitHub Discussions — 커뮤니티 "거실" (제로 컴퓨트, 단 한 번의 활성화)

<!-- doc-version: 1.0 -->
> **문서 버전 1.0** · 한국어 번역 · 최종 업데이트 2026-06-27 · 권위 있는 원본: [English](../COMMUNITY-DISCUSSIONS.md). 번역본이 영어 버전과 충돌하는 경우 영어 버전이 우선합니다.

> 사전 출시 체크리스트 항목 8. 한 문장 요약: **Issues는 티켓 창구, Discussions는 거실** — 질문하고, 결과물을 공유하고, 아이디어를 제안하는 모든 것이 여기서 이루어집니다; GitHub이 무료로 호스팅하며, 랜딩 페이지/순위표와 마찬가지로 **제로 컴퓨트**입니다.

---

## 1. Discussions가 필요한 이유 (또 다른 서비스가 아닌)

[`COMMUNITY-SITE.md`](../COMMUNITY-SITE.md)와 같은 입장입니다: 허브가 LLM을 직접 실행하지 않는 파일 우선 프로젝트에서는, **커뮤니티 인프라도 서버가 필요해서는 안 됩니다**. GitHub Discussions가 "거실" 전체를 호스팅합니다 — 스레드, 카테고리, @멘션, Markdown, 검색 — 모두 GitHub의 역할이며 우리 쪽의 백엔드 코드는 한 줄도 없습니다.

- **Issues** = "무언가 망가졌거나 빠졌다"를 위한 티켓 창구 (닫을 수 있고, 할당 가능하며, 상태가 있음).
- **Discussions** = "묻고 싶고, 보여주고 싶고, 이야기하고 싶다"를 위한 거실 (개방형, 투표 가능, 최선의 답변 표시 가능).

이 두 입구는 이미 [`.github/ISSUE_TEMPLATE/config.yml`](../../.github/ISSUE_TEMPLATE/config.yml)에 라우팅되어 있습니다 — 이슈를 열 때 "💬 질문 또는 토론" 연락 링크가 사람들을 Discussions로 보냅니다. **따라서 Discussions가 활성화되기 전에는 그 링크가 404입니다**; 활성화되면 즉시 라이브 상태가 됩니다.

---

## 2. ⚠️ 유일한 수동 작업: Discussions 활성화 (Claude는 도울 수 없습니다)

**Discussions 활성화는 저장소 설정 토글이지 파일이 아닙니다 — Claude도 CI도 이를 변경할 수 없습니다.** 이 단계는 저장소 소유자가 웹 UI에서 직접 수행해야 합니다:

1. `https://github.com/Emir-Aksoy/Gotong/settings` (저장소 **Settings**)를 엽니다.
2. **Features** 섹션으로 스크롤하여 **Discussions**를 체크합니다.
3. GitHub이 **기본 카테고리를 자동 생성**합니다: Announcements / General / **Ideas** / Polls / **Q&A** / **Show and tell**. 이 저장소와 함께 제공된 세 가지 폼 템플릿 (§4 참조)은 굵게 표시된 세 가지를 대상으로 하며, 활성화하는 **순간** 자동으로 연결됩니다 — 카테고리를 수동으로 생성할 필요가 없습니다.

> 이것이 "스캐폴딩은 준비되어 있고, 스위치 하나만 남았다"는 의미입니다: 템플릿 파일, 환영 게시물 초안, 이슈 라우팅 링크, 그리고 문서가 모두 저장소에 준비되어 있습니다; Features → Discussions를 클릭하면 거실이 열립니다.

활성화 후 두 가지가 더 권장됩니다 (모두 웹 UI에서 몇 번의 클릭으로, 선택 사항이지만 권장됨):

- **환영 게시물 고정**: §5 초안을 General 카테고리의 Discussion으로 게시하고 "Pin"을 클릭합니다.
- **(선택 사항) "Templates" 사용자 정의 카테고리 추가**: 템플릿 공유가 Show and tell의 수용 범위를 초과하면 별도로 생성합니다; 그러나 기본 Show and tell로 충분합니다 — 조급하게 추가하지 마세요.

---

## 3. 카테고리 맵 (프레임워크와 함께 준비된 세 가지)

| 카테고리 | 슬러그 | 폼 | 용도 |
|---|---|---|---|
| **Q&A** | `q-a` | [`q-a.yml`](../../.github/DISCUSSION_TEMPLATE/q-a.yml) | 도움말, 질문. "최선의 답변"을 표시할 수 있습니다. |
| **Ideas** | `ideas` | [`ideas.yml`](../../.github/DISCUSSION_TEMPLATE/ideas.yml) | 기능 / 방향 제안. 폼이 북극성과의 정렬을 유도합니다 (허브는 LLM을 실행하지 않음 / 파일 우선 / 피어 투 피어 페더레이션). |
| **Show and tell** | `show-and-tell` | [`show-and-tell.yml`](../../.github/DISCUSSION_TEMPLATE/show-and-tell.yml) | hub / 워크플로 / 템플릿을 공유합니다. **템플릿을 갤러리에 제출하는 것을 편리하게 안내**합니다 + `derivedFrom`을 작성하여 크레딧이 돌아가도록 합니다. |
| Announcements | `announcements` | — | 관리자 전용 (릴리스, 주요 변경 사항). 폼 없음. |
| General | `general` | — | 환영 게시물 + 미분류 대화. 폼 없음. |

**슬러그 = 파일명**: GitHub은 `.github/DISCUSSION_TEMPLATE/<slug>.yml` 폼을 동일한 이름의 카테고리에 연결합니다. 이 세 가지 슬러그는 활성화 시 GitHub이 **자동 생성**하는 기본 카테고리이므로, 카테고리를 수동으로 생성하고 이름을 맞출 필요 없이 "기본 제공"됩니다.

---

## 4. 폼 템플릿 (`.github/DISCUSSION_TEMPLATE/`)

[`.github/ISSUE_TEMPLATE/`](../../.github/ISSUE_TEMPLATE/)과 동일한 접근 방식 — 게시자가 사전에 유용한 정보를 제공하도록 유도하는 구조화된 폼입니다. 세 가지 템플릿은 각각 다음에 초점을 맞춥니다:

- **`q-a.yml`** — "무엇을 하려는지" (단순 오류가 아닌) + "무엇을 시도했는지" + 버전 + 실행 모드를 제공하도록 안내합니다; 그리고 **버그는 Issues로, 보안 문제는 SECURITY.md로** 돌려보냅니다 — 거실은 그 두 가지를 받지 않습니다.
- **`ideas.yml`** — "무엇을 원하는지" 전에 "무엇이 문제인지"를 묻고, 제안자가 스스로 **세 레이어 북극성에 대한 적합성을 판단**하도록 합니다 (허브가 LLM을 실행해야 하거나 / 상태를 숨기거나 / 자격 증명을 중앙화해야 하는 경우, 솔직하게 말하세요 — 거부권이 아니라 논의의 방향을 잡는 것입니다).
- **`show-and-tell.yml`** — 결과물을 보여주는 것 외에도, **"원클릭 갤러리에 들어갈 수 있는지" 안내를 전면에 배치**합니다: [커뮤니티 템플릿 제출 절차](../../templates/community/templates/README.md) 링크, `slug`와 `derivedFrom` 수집 (인용 순위표 기여), 갤러리의 두 가지 엄격한 규칙 (자격 증명은 `${ENV}`여야 함, 지식 콘텐츠/인원 없음)을 체크박스로 전환합니다.

> 폼 필드는 영어로 되어 있습니다 — 기존 `.github/ISSUE_TEMPLATE/` 규칙과 일관되게; 각 폼의 소개 블록은 중국어를 주로 사용하는 사용자를 위해 한 줄짜리 중국어 힌트를 추가합니다. 환영 게시물 (§5)은 중국어 우선, 영어 차순입니다.

---

## 5. 환영 / 고정 게시물 초안 (복사해 붙여넣기 준비 완료)

Discussions를 활성화한 후, **아래 전체 블록을 복사**하고, **General** 카테고리에 제목 `👋 欢迎来到 Gotong 客厅 / Welcome`으로 새 Discussion을 게시한 다음 **Pin**을 클릭합니다. 원본 초안은 중국어 (커뮤니티의 주요 청중)를 먼저, 영어를 다음으로 배치합니다; 청중에 맞게 순서를 조정하세요.

```markdown
## 👋 Welcome to the Gotong living room

This is where the Gotong community hangs out — ask, show, and talk shop. The map:

- **🙋 A question?** Open one in **Q&A**. Say what you're trying to do and what you
  tried; someone will help.
- **🛠 Built something?** Show it in **Show & Tell**. If it's a template others can
  import-and-run, submit it to the one-click gallery via the
  [submit flow](../../tree/main/templates/community/templates).
- **💡 An idea?** Pitch it in **Ideas**. Gotong has a deliberate spine — aiming with
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

## 👋 欢迎来到 Gotong 客厅

这里是 Gotong 的客厅——问问题、晒成果、聊想法的地方。先认认门:

- **🙋 有问题?** 去 **Q&A** 开一帖。说清楚你想做什么、试过什么,有人会帮你。
- **🛠 做了东西?** 去 **Show & Tell** 晒出来。如果是一个**别人能照着导入就跑**的
  模板,顺手按 [提交流程](../../tree/main/templates/community/templates) 提进一键画廊。
- **💡 有想法?** 去 **Ideas** 提。Gotong 有一条明确的脊梁,对着它提更容易被采纳:
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

> 위 초안의 링크는 GitHub 저장소 상대 경로 (`../../tree/main/…`, `../../blob/main/…`)를 사용하며, Discussion에 붙여넣으면 저장소 파일로 올바르게 해석됩니다. 게시 전에 미리보기로 끊어진 링크가 없는지 확인하세요.

---

## 6. 나머지와의 연결

이 항목은 독립적이지 않습니다 — 거실을 사전 출시 체크리스트가 이미 마련한 라인들과 연결합니다:

- **이슈 라우팅**: [`ISSUE_TEMPLATE/config.yml`](../../.github/ISSUE_TEMPLATE/config.yml)의 "💬 질문 또는 토론" 링크는 오래전부터 `/discussions`를 가리키고 있었습니다; 활성화되면 이 링크가 404를 벗어납니다.
- **템플릿 갤러리 / 순위표**: Show & Tell 폼은 템플릿 작성자를 [커뮤니티 템플릿 제출 절차](../../templates/community/templates/README.md)로 안내합니다; 제출이 병합되면 원클릭 갤러리 ([`TEMPLATE-GALLERY.md`](../zh/TEMPLATE-GALLERY.md))와 정적 쇼케이스 ([`COMMUNITY-SITE.md`](../COMMUNITY-SITE.md))에 나타납니다; 폼이 수집하는 `derivedFrom`이 인용 순위표에 기여합니다.
- **거버넌스**: [`GOVERNANCE.md`](../../GOVERNANCE.md)는 Discussions를 기여자 입구 중 하나로 나열합니다; Ideas에서 형성되는 방향은 GOVERNANCE의 의사 결정 프로세스를 통해 반영됩니다.

`.github/RELEASE-CHECKLIST.md`의 "GitHub Discussions 활성화" 항목이 이제 이 문서를 가리킵니다.

---

## 7. 경계 (솔직한 설명)

- **Claude는 Discussions를 활성화할 수 없습니다**: 그것은 저장소 Settings의 토글이며 (§2), 소유자만 웹 UI에서 클릭할 수 있습니다. 이 저장소가 할 수 있는 것 — "스캐폴딩": 폼 템플릿, 환영 게시물 초안, 라우팅 링크, 문서 — 은 모두 준비되어 있습니다.
- **폼은 검토가 아닙니다**: Discussion 템플릿은 게시를 **안내**할 뿐, 차단하거나 검증하지 않습니다. 템플릿이 갤러리에 들어갈 때의 실제 검증은 [`pnpm check:templates`](../../templates/community/templates/README.md) (실제 `parseTemplate` 통과)이며, 이는 별도의 사안입니다.
- **강제 기록 마이그레이션 없음**: 오늘 문서 전반에 걸쳐 `/discussions`를 가리키는 링크들 (REAL-WORLD-TESTING, LICENSE-FAQ 등)은 활성화되면 자연스럽게 라이브 상태가 되며, 이를 수정하러 돌아갈 필요가 없습니다.

---

## 관련 문서

- [`COMMUNITY-SITE.md`](../COMMUNITY-SITE.md) — 제로 컴퓨트 정적 쇼케이스 (같은 입장의 다른 절반).
- [`TEMPLATE-GALLERY.md`](../zh/TEMPLATE-GALLERY.md) — admin 콘솔 내 원클릭 설치 갤러리.
- [`FLAGSHIP-TEMPLATES.md`](../FLAGSHIP-TEMPLATES.md) — 플래그십 템플릿 큐레이션 인덱스 + 인용 순위표.
- `../../CONTRIBUTING.md` · `../../GOVERNANCE.md` · `../../CODE_OF_CONDUCT.md` — 커뮤니티 루트 파일.
- [`templates/community/templates/README.md`](../../templates/community/templates/README.md) — 5단계 템플릿 제출 절차.
