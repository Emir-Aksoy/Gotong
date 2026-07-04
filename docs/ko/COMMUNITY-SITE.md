# 커뮤니티 랜딩 페이지 + 템플릿 갤러리 + 인용 순위표 (제로 컴퓨트 정적 사이트)

<!-- doc-version: 1.0 -->
> **문서 버전 1.0** · 한국어 번역 · 최종 업데이트 2026-06-27 · 권위 있는 원본: [English](../COMMUNITY-SITE.md). 번역본이 영어 버전과 충돌하는 경우 영어 버전이 우선합니다.

> 사전 출시 체크리스트 항목 7. 한 문장 요약: **커뮤니티는 제로 컴퓨트로 운영됩니다** — 정적 파일 묶음으로 빌드하고 무료 정적 호스팅에 올리면 바로 라이브 상태가 됩니다; 클라우드 서버는 예비로 남겨둡니다.

---

## 1. "제로 컴퓨트"인 이유

Gotong의 전체 설계 철학은 **허브가 LLM을 직접 실행하지 않는다 / 상태는 모두 디스크 파일이다 / 자격 증명은 본인 기기에 있다 / 페더레이션은 피어 투 피어다**입니다. 이 철학을 따르면 **커뮤니티 인프라에도 서버가 필요 없습니다**:

- **GitHub이 이미 핵심 내용을 호스팅합니다** — 템플릿은 파일이고, 제출은 PR입니다.
- **빠져 있는 것은 오직 쇼케이스** — 파일 우선 프로젝트의 쇼케이스 자체도 정적 파일 묶음입니다.

따라서 이 쇼케이스 = 제너레이터 하나 + 그것이 생성하는 정적 파일들입니다. 제너레이터는 [`packages/web/scripts/build-site.mjs`](../../packages/web/scripts/build-site.mjs)이며, `site/` (저장소 루트, gitignored)를 생성합니다:

- `index.html` — 완전 자급 단일 파일 (프레임워크 없음, 런타임 없음, CSS 인라인): 신뢰 서사 히어로 + 템플릿 갤러리 카드 그리드 + 인용 순위표.
- `templates.json` — 기계 가독형 `gotong.site/v1` 피드 (쇼케이스도 데이터이며, 파일 우선입니다).

`site/`를 GitHub Pages / Cloudflare Pages / Netlify 무료 티어 중 어디에 올려도 쇼케이스가 **$0**으로 라이브 상태가 됩니다. 텐센트 클라우드 2c2G 서버는 예비로 계속 유지됩니다.

---

## 2. 빌드 방법

```bash
pnpm build:site          # 루트 스크립트, packages/web에 위임
# 또는
pnpm -C packages/web build:site
```

출력:

```
build-site: 11 templates → site/ (index.html + templates.json), 2 on the leaderboard
```

`site/`는 **수요에 따라 빌드되는 파생 아티팩트이며 저장소에 체크인되지 않습니다** (`dist-portable/`와 같은 입장, `.gitignore` 참조). 단일 진실의 원천은 `examples/`와 `templates/community/`에 있으며 (템플릿/프레임워크 분리), 쇼케이스는 그것들의 읽기 전용 투영입니다 — 템플릿을 변경한 후 제너레이터를 다시 실행하면 됩니다.

**결정론**: 제너레이터는 타임스탬프를 쓰지 않으며 안정적으로 정렬합니다 → 동일한 입력은 **바이트 단위로 동일한** `site/`를 생성하므로 재빌드 시 의미 없는 diff가 발생하지 않습니다.

---

## 3. 코퍼스 = 검증된 것과 동일한 집합

제너레이터는 저장소 수준 검증 게이트 (`pnpm check:templates` / [`tests/all-templates-parse.test.ts`](../../packages/web/tests/all-templates-parse.test.ts))가 검증하는 것과 **정확히** 동일한 두 루트를 스캔합니다:

| 출처 | 경로 | 비고 |
|---|---|---|
| `flagship` | `examples/*/template/*.template.ya?ml` | 프레임워크와 함께 배포되는 플래그십 템플릿 |
| `community` | `templates/community/templates/**/*.ya?ml` | 커뮤니티 제출물이 위치하는 곳 |

따라서 "CI를 통과하는 모든 템플릿이 쇼케이스에 나타난다"는 것이 **구조적으로 보장됩니다** — 파싱되지 않는 매니페스트는 카드에 절대 도달할 수 없습니다 (`check:templates`에서 실패하고 들어오지 못합니다).

---

## 4. 인용 순위표 = `provenance.derivedFrom`의 인입 차수

순위표는 가산적 출처 필드 `template.provenance.derivedFrom` (사전 출시 체크리스트 항목 6)을 읽습니다:

- `derivedFrom` 항목 하나가 하나의 **인용 엣지**입니다: "이 템플릿이 누구에게서 파생되었는지"를 선언합니다.
- 순위 = **인입 차수** = "얼마나 많은 템플릿이 나로부터 파생되었는가."
- 엣지는 대상 템플릿의 **슬러그** (공개 핸들, 아래 참조)를 참조하므로, 템플릿을 포크할 때 `provenance.derivedFrom`에 **업스트림의 슬러그**를 작성하면 귀속 계보가 완성됩니다.

프레임워크와 함께 배포된 두 개의 실제 인용 엣지 (`CLAUDE.md`에도 작성됨):

```yaml
# examples/codex-deepseek-hub/template/codex-deepseek-hub.template.yaml
provenance:
  derivedFrom: [personal-coding-hub]   # 자매 예제, 동일한 dispatch 뼈대

# examples/tea-chain-hq/template/chain-hq.template.yaml
provenance:
  derivedFrom: [tea-supply-link]       # MIRROR, 반대 방향의 크로스 조직 오케스트레이션
```

→ 순위표에서 `personal-coding-hub`와 `tea-supply-link`가 각각 1표를 얻습니다.

**오타는 조용히 무시되지 않습니다**: `derivedFrom`이 존재하지 않는 슬러그를 가리키면 제너레이터가 stderr에 `WARNING … no template with that slug`를 출력합니다 (`buildModel`이 이를 `unresolved`로 수집), 조용히 0표로 건너뛰지 않습니다.

---

## 5. 슬러그 (공개 핸들) 체계

슬러그는 템플릿의 **안정적인 공개 정체성**입니다 — 갤러리 (`builtin-templates.ts`), `FLAGSHIP-TEMPLATES.md`, 그리고 이 쇼케이스가 동일한 핸들을 사용하므로, 포크의 `derivedFrom`이 "모두가 아는 이름"으로 업스트림을 참조할 수 있습니다. `assignSlugs` 규칙:

| 출처 | 슬러그 |
|---|---|
| flagship, `examples/<dir>` 아래 템플릿 파일이 **정확히 하나** | `<dir>`의 기본 이름 (예: `examples/tea-supply-link`에 `tea-shop.template.yaml`이 있으면 → 슬러그 `tea-supply-link`, 파일명이 아님) |
| flagship, 같은 디렉토리 아래 **여러** 템플릿 파일 | 파일명 스템으로 구별 (예: `examples/family-learning-hub`에 `family-tutor` + `child-desk`가 있음) |
| community | 파일명 스템 |

**충돌은 빌드 실패입니다**: 두 템플릿이 같은 슬러그를 계산하면 → `assignSlugs`가 예외를 던집니다. 모호한 공개 핸들은 빌드 시간에 크게 오류를 내야 하며, 조용히 덮어씌워진 카드 / 잘못된 템플릿을 가리키는 엣지가 되어서는 안 됩니다. (이 고유성 검사는 실제 문제가 발생한 것입니다: `family-tutor`와 `child-desk`가 같은 디렉토리에 있고 이전에 둘 다 `family-learning-hub`라는 디렉토리 이름을 사용해 충돌했습니다.)

---

## 6. 배포 (무료 정적 호스팅)

`site/`는 순수 정적 아티팩트이므로 무료 티어라면 어디든 작동합니다. **GitHub Pages**를 예로 들면 (Actions 쿼터 불필요 — 로컬에서 빌드하고, `gh-pages` 브랜치에 수동으로 푸시하거나 Pages `/docs` 규칙 사용):

```bash
pnpm build:site
# 그런 다음 site/의 내용을 원하는 정적 호스트에 게시합니다:
#   · Cloudflare Pages / Netlify: site/를 드래그 앤 드롭하거나, "build: pnpm build:site,
#     output: site" 훅을 연결합니다 (해당 무료 티어는 자체 빌드 쿼터를 가지며, 이 저장소의 Actions 쿼터와 무관합니다);
#   · GitHub Pages: 로컬에서 빌드한 후 site/를 gh-pages 브랜치에 푸시합니다.
```

> ⚠️ 이 저장소의 **GitHub Actions 쿼터가 소진**되어 있으므로, 스토어의 빌드는 이 저장소의 CI에 **의존하지 않습니다**. 제너레이터는 로컬에서 실행됩니다 (무료); 정적 호스트의 자체 빌드 쿼터는 별도의 사안입니다. `site/`는 체크인되지 않으므로 저장소 용량을 늘리지 않습니다.

---

## 7. 안티-로트 테스트

[`tests/build-site.test.ts`](../../packages/web/tests/build-site.test.ts)는 제너레이터의 순수 로직을 고정합니다 (IO 쉘이 보호되어 있으므로 `import`가 파일 스캔을 트리거하지 않고 파일을 쓰지도 않습니다):

- `assignSlugs` — 세 가지 슬러그 규칙 + 고유성 검사 (실제 문제의 회귀 방어선);
- `extractTemplate` — 원시 매니페스트에서 표시 서피스 + `provenance.derivedFrom` (빈 항목 필터링)을 읽고, 잘못된 스키마에서 크게 예외를 던짐;
- `buildModel` — 인용 인입 차수 계산 + 순위표 정렬 + 오타가 있는 참조를 `unresolved`로 표시;
- `escapeHtml` / `render*` — 커뮤니티 제공 이름/설명은 **신뢰할 수 없으므로**, XSS 케이스는 `<script>`가 마크업에서 절대 탈출할 수 없음을 고정합니다.

---

## 8. 경계 (솔직한 설명)

- 쇼케이스는 **템플릿 편집기가 아니며** 아무것도 설치하지 않습니다 — 읽기 전용 표시 창입니다. 설치는 admin 콘솔의 "템플릿 갤러리" 원클릭 설치 / `POST /api/admin/templates/import`를 통해 진행합니다 ([`TEMPLATE-GALLERY.md`](../zh/TEMPLATE-GALLERY.md) 참조).
- **템플릿/프레임워크 분리**는 깨지지 않습니다: 쇼케이스는 매니페스트의 **구조 + 참조**만 읽으며, 지식 콘텐츠나 인원을 표시하거나 전달하지 않습니다 (결정 #4/#5).
- `site/`는 빌드 시점의 스냅샷입니다: `examples/*/template/`을 변경하거나 커뮤니티 템플릿을 추가한 후에는 반드시 `pnpm build:site`를 **다시 실행**해야 합니다; 안티-로트 테스트가 감시 역할을 합니다.

---

## 관련 문서

- [`TEMPLATE-GALLERY.md`](../zh/TEMPLATE-GALLERY.md) — admin 콘솔 내 원클릭 설치 갤러리 (동일한 코퍼스의 또 다른 소비자).
- [`FLAGSHIP-TEMPLATES.md`](../FLAGSHIP-TEMPLATES.md) — 플래그십 템플릿의 큐레이션 인덱스.
- [`HANDS-ON-HUBS.md`](../zh/HANDS-ON-HUBS.md) — 기본 제공 hub 예제 비교 + go-live 런북.
- `../../CONTRIBUTING.md` — 커뮤니티 템플릿 제출 절차 (라이선스 정리 + `pnpm check:templates` 통과).
