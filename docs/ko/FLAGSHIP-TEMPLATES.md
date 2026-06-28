# 플래그십 템플릿 — 일반인이 가져다 바로 사용할 수 있는 hub

<!-- doc-version: 1.0 -->
> **문서 버전 1.0** · 한국어 번역 · 최종 업데이트 2026-06-27 · 권위 있는 원본: [English](../FLAGSHIP-TEMPLATES.md). 번역본이 영어 버전과 충돌하는 경우 영어 버전이 우선합니다.

> 이것은 **보증된** 템플릿 목록입니다. "플래그십"은 "최고"가 아니라 "우리가 보증한다"는 의미입니다: 각각은 **결정론적 데모** (명령 하나, 키 불필요, 자체 동작 검증)를 제공하고, 각각은 **거버넌스 자세** (무엇을 건드릴 수 있는지, 무엇을 건드릴 수 없는지, 어디서 사람이 게이트 역할을 하는지)를 공개하며, 각각은 **유지 관리됩니다**.
>
> 모든 템플릿 (커뮤니티 티어 포함)을 보고 싶으신가요? admin UI의 "Workflows → Template Gallery"를 확인하세요. 직접 제출하고 싶으신가요: [`templates/community/templates/`](../../templates/community/templates/). 이 목록의 선정 기준은 [`GOVERNANCE.md`](../../GOVERNANCE.md)에 작성되어 있습니다.

---

## 왜 이것들인가

AipeHub의 차별점은 "AI를 호출할 수 있다"는 것이 아닙니다 — 그건 어디서나 됩니다. 차별점은 **집, 가족, 돈을 향해 AI를 과감히 지향할 수 있다는 것**이며, 그 이유는 경계가 실재하고 그 경계가 바로 당신의 것이기 때문입니다:

- **인간이 중요한 행동을 게이팅합니다.** 되돌릴 수 있는 것들 (조명 끄기)은 그냥 실행됩니다; 되돌릴 수 없는 것들 (문 잠그기, 돈 쓰기, 아이의 데이터 전송)은 중단되고 사람이 수신함에서 확인할 때까지 기다립니다 — 워크플로는 그 게이트를 **건너뛸 수 없습니다**.
- **키와 데이터가 자신의 디스크에 있습니다.** 자격 증명은 `.aipehub/` 디렉토리에 암호화되어 있습니다. 다른 hub와 페더레이션하면 **기능**을 공유하지, vault를 공유하지 않습니다.
- **블랙박스 결정이 없습니다.** 모든 dispatch와 결과는 읽을 수 있는 읽기 전용 트랜스크립트입니다. 프레임워크는 모델을 실행하지 않으며, 숨겨진 판단이 없습니다.

아래의 각 템플릿은 이 세 가지 원칙이 **하나의 구체적인 것에 착지한** 것입니다.

---

## 한눈에 보기

| 템플릿 | 대상 | 사람이 게이팅하는 곳 (거버넌스 자세) | 실행하기 (키 불필요) |
|---|---|---|---|
| **smart-home-hub** 스마트 홈 | 스마트 홈 기기가 있는 사람 | 조명/에어컨은 바로 실행; **문 잠그기, 보안 설정**은 거주자의 수신함 확인 필요 | `pnpm demo:smart-home-hub` |
| **family-learning-hub** 가족 학습 | 아이에게 AI를 열어주는 부모 | 화이트리스트 외 주제와 아이 데이터 전송 **둘 다 부모 승인 필요**; 구독과 데이터 각각 집에 보관 | `pnpm demo:family-learning-hub` |
| **cafe-ops** 매장 운영 | 소규모 가게 주인 / 관리자 | 초과 근무 수당: **어시스턴트는 제안만, 관리자가 금액 결정**; 스케줄링은 관리자 확인 필요 | `pnpm demo:cafe-ops` |
| **personal-coding-hub** 개인 코딩 | AI로 코드 작성을 돕고 싶은 사람 | 위험한 명령 (rm -rf / push --force)은 승인 대기로 중단; 분업은 직접 설정 | `pnpm demo:personal-coding-hub` |
| **codex-deepseek-hub** 코딩 (Codex+DeepSeek) | 동일, 다른 모델 세트 | 동일 | `pnpm demo:codex-deepseek-hub` |
| **personal-research-hub** 개인 연구 | 정리할 자료가 산더미인 사람 | 읽기 전용 컴파일, 원자료를 상호 링크된 wiki로 변환 | `pnpm demo:personal-research-hub` |
| **battle-monk-training** 개인 성장 | 일일 훈련 계획이 필요한 사람 | 본인의 성장 기록만 작성; 의료/심리 조언 제공 않음 | `pnpm demo:battle-monk-training` |
| **warband-club** 동호회 | 취미 커뮤니티 / 전단 | 공유 아카이브는 누구나 읽기/쓰기; 중요한 결정은 대장의 확인을 거침 | `pnpm demo:warband-club` |
| **tea-supply-link** 크로스 조직 공급 | 공급업체와 거래하는 가게 | 주문은 **조직 경계를 넘기 전에 사람 승인 필요**; 공급업체가 금액 계산, 사람이 결정 | `pnpm demo:tea-supply-link` |
| **tea-chain-hq** 체인 본사 | 가맹점을 관리하는 본사 | 가격 인하 지시는 **출시 전 지역 관리자 승인 필요**; 가게는 종속 객체가 아닌 주권 당사자 | `pnpm demo:tea-chain-hq` |

각각에는 `pnpm demo:<name>:template`도 있습니다 — 해당 템플릿 파일을 읽어들여 파싱하고 선언된 아키텍처를 미리 봅니다 (서브프로세스 없음, 키 없음), "템플릿에 무엇이 들어 있는지, 무엇이 그 밖에 있는지"를 확인할 수 있습니다.

---

## 가정 & 가족

### ⭐ smart-home-hub — 스마트 홈 (소미 via Home Assistant)

**누가 / 무엇을.** 홈 스튜어드가 Home Assistant를 통해 소미 (또는 HA 연동 가능한 모든) 기기를 제어하며 "취침 예약 루틴"을 실행합니다.

**건드릴 수 있는 것.** 공동 구역 조명 끄기, 침실 에어컨을 수면 모드로 전환하기 — 이것들은 **되돌릴 수 있으므로** 바로 실행됩니다.

**사람이 게이팅하는 곳 (거버넌스 자세).** 현관문 잠그기와 보안 설정은 **되돌릴 수 없는 물리적 / 보안** 행동입니다 — 워크플로는 이 단계에 도달하면 **중단**되고 거주자가 `/me` 수신함에서 "확인"을 클릭할 때까지 기다린 후 실행합니다. 거부 → `when:` 게이트가 그 단계를 건너뜀 → **문은 잠금 해제 상태로 유지**됩니다 (fail-closed, 다음 행동 차단, 파급 없음). 이것이 "되돌릴 수 있는 것은 바로 실행, 되돌릴 수 없는 것은 사람 확인 필요"가 가정에서 어떻게 구현되는지입니다.

**템플릿 / 프레임워크 분리.** 템플릿의 기기 MCP 배선은 `${HA_MCP_SSE_URL}` / `${HA_TOKEN}` 플레이스홀더입니다 — 어떤 Home Assistant에 연결하고 어떤 토큰을 사용하는지는 가져온 후 채워지는 런타임 설정입니다. 워크플로는 기능 (`home.apply-scene` / `home.secure`)만 지정하며 특정 기기를 절대 언급하지 않습니다. 기기를 바꾸고, 집을 바꿔도 워크플로는 한 글자도 바꾸지 않아도 됩니다. 이 템플릿에는 **KB 슬롯이 없습니다** (기기 상태는 HA에서 실시간으로, 별도의 지식 베이스 필요 없음).

- 실행하기: `pnpm demo:smart-home-hub` (두 시나리오: 승인 → 문 잠김; 거부 → 문 잠금 해제 유지)
- 템플릿: [`examples/smart-home-hub/template/smart-home-hub.template.yaml`](../../examples/smart-home-hub/template/smart-home-hub.template.yaml)
- 실제 Home Assistant 연결: [README](../../examples/smart-home-hub/README.md) 참조

### ⭐ family-learning-hub — 가족 학습 (부모가 아이에게 AI를 열어주기)

**누가 / 무엇을.** 부모가 AI 구독을 결제하고, 아이는 **별도의** hub에서 학습합니다; 아이의 hub가 승인을 통해 부모의 구독을 호출하고, AI 튜터 (Matt Pocock의 `/teach` 재현: 먼저 사명 확립, 작은 한 걸음, 기술 전에 지식, 1차 자료 인용)가 아이의 탐구를 안내합니다. 목록에서 **가장 생산 환경에 가깝게 검증된** 것입니다 (실제 ws 페더레이션 + IM 모니터링 + 실제 DeepSeek 모두 실행됨).

**건드릴 수 있는 것.** 화이트리스트 주제 내에서는 튜터가 직접 가르칩니다; 학습 기록의 **원본 사본**은 아이의 hub에 있습니다.

**사람이 게이팅하는 곳 (거버넌스 자세) — 네 가지 게이트.**

1. **주제 화이트리스트 + 콘텐츠 자체 평가** → 화이트리스트 외 주제, 그리고 튜터가 스스로 `flagged`로 표시한 콘텐츠는 **부모 승인 대기로 중단**됩니다.
2. **데이터 분류 게이트**: 아이의 데이터는 `child-learning`으로 태그되며, 해당 데이터 클래스를 승인받지 않은 제3자에게 전송될 수 없습니다 (fail-closed).
3. **관할권**: 부모가 구독을 보유 (경제적 제어권) + 페더레이션 링크별 신뢰 계약 + 전체 트랜스크립트 포크 (부모가 모니터링 사본을 받음).
4. **자격 증명 / 데이터 각각 집에 보관**: 두 개의 주권 hub, 아이의 데이터는 아이 쪽에서 부모에게 사본을 보내지만, 구독과 vault는 교차하지 않습니다.

**템플릿 / 프레임워크 분리.** 크로스 조직 링크 (어떤 아이 피어, 어떤 기능이 아웃바운드 허용, 승인 정책, `allowedDataClasses`)는 **런타임 피어 설정**이며 템플릿이나 워크플로 어디에도 없습니다. 두 개의 템플릿: 부모 측 `family-tutor` (튜터 + 화이트리스트/승인 워크플로 포함), 아이 측 `child-desk` (구독 없음 + 학습 기록 원본 사본).

- 실행하기: `pnpm demo:family-learning-hub` (여섯 시나리오, 화이트리스트 외→부모 승인 / 부모 거부→수업 미진행 포함)
- 템플릿: [`family-tutor`](../../examples/family-learning-hub/template/family-tutor.template.yaml) · [`child-desk`](../../examples/family-learning-hub/template/child-desk.template.yaml)
- 실제 배포 (두 대의 주권 머신): [`docs/zh/FAMILY-LEARNING-GO-LIVE.md`](../zh/FAMILY-LEARNING-GO-LIVE.md) · 설계: [`FAMILY-LEARNING-HUB-DESIGN.md`](../zh/FAMILY-LEARNING-HUB-DESIGN.md)

---

## 개인 생산성

### personal-coding-hub — 개인 코딩 (Claude Code + Codex 분업)

**누가 / 무엇을.** 라우팅 "모델"이 작업을 분석하고 + 당신의 배치를 고려하여, Claude Code 또는 Codex에 작업을 파견할지 결정합니다; 두 코딩 에이전트는 하나의 작업 디렉토리를 공유하고 `AGENTS.md` (사양) + `PROGRESS.md` (인계 배턴)를 통해 협업합니다. **대립적 회의**도 있습니다: 문제가 생겼을 때 여러 에이전트가 함께 코드를 읽고, 먼저 독립적으로 진단한 다음 상호 질의응답을 통해 진짜 근본 원인을 찾아냅니다.

**사람이 게이팅하는 곳 (거버넌스 자세).** 위험한 명령 (`rm -rf`, `git push --force`, `sudo`, `curl | sh` …)은 실행 **전에** 중단하여 승인을 기다립니다; 거부 → fail-closed, 명령은 실행되지 않습니다. 분업은 **당신이 결정합니다**: 임시로 지정하거나 ("이건 codex에게") 전체 분업 레이어를 일반적인 말로 변경합니다 (OpenClaw 방식, `routing-policy.json`에 다시 저장됨).

**템플릿 / 프레임워크 분리.** 템플릿에는 멘토 에이전트 1개 (`coding-mentor`, DeepSeek + 인라인 mcp-obsidian) + 주소 지정 가능한 KB 슬롯 1개 (방법론 라이브러리, `presetData` 포인터)가 포함됩니다. 두 개의 CLI 코딩 에이전트는 **런타임에 배선됩니다** (CliParticipant는 관리 에이전트 목록에 들어가지 않음); 지식 **콘텐츠**는 템플릿 밖에 있습니다.

- 실행하기: `pnpm demo:personal-coding-hub` (10 시나리오: 분업 / 명시적 할당 / 일반 언어 재분배 / 안전 게이트)
- 회의: `pnpm demo:personal-coding-hub:consult`
- 템플릿: [`examples/personal-coding-hub/template/personal-coding-hub.template.yaml`](../../examples/personal-coding-hub/template/personal-coding-hub.template.yaml)

### codex-deepseek-hub — 코딩 (Codex + DeepSeek TUI)

personal-coding-hub의 **자매**: 다른 모델 세트 — Codex (빠른 구현자) + DeepSeek TUI (추론 리드). 동일한 라우팅 + 일반 언어 재분배 + 명시적 할당 + 안전 게이트, 독립적으로 동작하며 personal-coding-hub를 건드리지 않습니다.

- 실행하기: `pnpm demo:codex-deepseek-hub`
- 템플릿: [`examples/codex-deepseek-hub/template/codex-deepseek-hub.template.yaml`](../../examples/codex-deepseek-hub/template/codex-deepseek-hub.template.yaml)

### personal-research-hub — 개인 연구 / 지식 hub

**누가 / 무엇을.** 사서가 원자료를 상호 링크된 Obsidian wiki로 **컴파일**하고 (LLM-as-compiler), "wiki에게 질문"하게 합니다. 세 개의 관리형 LLM 에이전트 (사서 / 컴파일러 / 연구자)가 팀으로 이동합니다.

**거버넌스 자세.** 컴파일은 원자료를 노트 + 역링크로 변환하는 **읽기 전용** 작업입니다; 답변은 출처를 인용하고 `wiki/answers/`에 보관합니다.

- 실행하기: `pnpm demo:personal-research-hub`
- 템플릿: [`examples/personal-research-hub/template/personal-research-hub.template.yaml`](../../examples/personal-research-hub/template/personal-research-hub.template.yaml)

### battle-monk-training — 개인 성장 (신체 / 정신 / 지식, 세 기둥)

**누가 / 무엇을.** 지도 수사가 오늘의 훈련을 세 기둥 (신체 / 정신 / 지식)에 파견하며, 각각은 기록에 이미 훈련된 단계를 기반으로 다음 단계를 진행하고, 연속성이 설계의 핵심입니다 — Obsidian KB가 **당신의 상태를 저장**합니다 (참조 자료가 아님). 냉혹한 grimdark-수도원 스타일 (원창작 팬 오마주, 워해머 40k 스타일 사용자를 대상으로 함).

**거버넌스 자세 / 안전 경계.** **오직 본인의 성장 기록만 씁니다**; 이것은 개인 데이터이며, **의료 / 심리 조언이 아닙니다** — 어떤 것의 유일한 근거로 삼지 마세요.

- 실행하기: `pnpm demo:battle-monk-training`
- 템플릿: [`examples/battle-monk-training/template/battle-monk-training.template.yaml`](../../examples/battle-monk-training/template/battle-monk-training.template.yaml)

---

## 조직 & 크로스 조직

### cafe-ops — 매장 운영 (버블티 / 커피 가게)

**누가 / 무엇을.** 소규모 가게의 공식 프로세스: 신입 사원 온보딩 (직책 SOP 학습, 회원 셀프 서브), 스케줄링 (관리자 확인), 초과 근무 수당 (관리자 승인). `workflows[]`가 비어 있지 않은 첫 번째 템플릿 — 조직의 가치는 공식 프로세스에 있습니다.

**사람이 게이팅하는 곳 (거버넌스 자세).** 초과 근무 수당: **어시스턴트는 금액을 제안할 뿐, 관리자가 금액을 결정합니다**: 어시스턴트는 일 유형별 배수를 계산하지만 (평일 1.5 / 휴일 2 / 법정 공휴일 3), 워크플로는 승인 단계에 도달하면 중단되고 관리자가 수신함에서 승인한 후에야 실행됩니다. **금액은 결정론적으로 계산되며 LLM이 아닌 사람이 결정합니다.**

- 실행하기: `pnpm demo:cafe-ops` (초과 근무 HITL 2단계 재개 포함)
- 템플릿: [`examples/cafe-ops/template/cafe-ops.template.yaml`](../../examples/cafe-ops/template/cafe-ops.template.yaml)

### warband-club — 동호회 (공유 아카이브)

**누가 / 무엇을.** 취미 커뮤니티 / 전단의 **협업 면** (cafe-ops의 관리 면 대비): 전체 그룹이 읽고 쓰는 공유 아카이브 — 당신이 제출한 도색 방안 / 전투 보고서를 다른 사람이 조회할 수 있으며; 당신이 받는 답변이 다른 사람의 이전 기여에서 올 수 있습니다 = 협업.

**거버넌스 자세.** 공유 아카이브는 누구나 읽기/쓰기 가능합니다; 중요한 결정 (집결)은 대장의 `human:` 확인을 거칩니다. 하나의 hub 내 공유, 페더레이션 없음.

- 실행하기: `pnpm demo:warband-club`
- 템플릿: [`examples/warband-club/template/warband-club.template.yaml`](../../examples/warband-club/template/warband-club.template.yaml)

### tea-supply-link — 크로스 조직 공급 (차 가게 ↔ 공급업체)

**누가 / 무엇을.** 첫 번째 **크로스 조직** 템플릿: 차 가게의 재고 보충 워크플로가 한 단계를 **공급업체의 hub**로 오케스트레이션합니다.

**사람이 게이팅하는 곳 (거버넌스 자세).** 크로스 조직 주문 단계는 **아웃바운드 승인 게이트**를 거칩니다 (워크플로에 투명하므로 워크플로에 `human:` 단계가 **없음**) — 관리자가 승인한 후에야 경계를 넘으며, 공급업체가 카탈로그 + 실시간 재고로 품목별 가격을 책정하고 영수증이 다시 돌아와 로컬에 파일로 저장됩니다. 공급업체가 금액을 계산하고, 사람이 발주를 결정합니다.

**템플릿 / 프레임워크 분리 (교육 포인트).** 크로스 조직 링크 (어떤 피어가 공급업체인지, 어떤 기능이 아웃바운드 허용인지, 승인 정책)는 **런타임 피어 설정**이며 템플릿이나 워크플로 어디에도 없습니다 — `place` 단계는 기능 `supplier.confirm-order`만 지정하고 피어 이름을 절대 언급하지 않습니다.

- 실행하기: `pnpm demo:tea-supply-link`
- 템플릿 (가게 측): [`examples/tea-supply-link/template/tea-shop.template.yaml`](../../examples/tea-supply-link/template/tea-shop.template.yaml)
- 두 머신 운영자 런북: [`docs/zh/FEDERATION-RUNBOOK.md`](../FEDERATION-RUNBOOK.md)

### tea-chain-hq — 체인 본사 (본사 → 가맹점)

**누가 / 무엇을.** tea-supply-link의 **거울, 반대 방향**: 그쪽은 위로 올라가고 (가게→공급업체), 이쪽은 아래로 내려갑니다 (본사→가맹점). 세 레이어 체인 `본사 → 가게 → 공급업체`에서 가게는 가운데 있습니다.

**사람이 게이팅하는 곳 (거버넌스 자세).** 가격 재조정 지시를 출시하는 크로스 조직 단계는 아웃바운드 승인 게이트를 거칩니다 — 지역 관리자가 승인한 후에야 경계를 넘으며, 가게는 자신의 메뉴에 따라 결정론적으로 가격 재조정을 적용하고 영수증이 다시 돌아옵니다. **가게는 종속 객체가 아닌 주권 조직입니다.**

- 실행하기: `pnpm demo:tea-chain-hq`
- 템플릿 (본사 측): [`examples/tea-chain-hq/template/chain-hq.template.yaml`](../../examples/tea-chain-hq/template/chain-hq.template.yaml)

---

## 단 하나의 명령으로 실행 (결정론적, 키 불필요)

각 플래그십에는 **결정론적 데모**가 있습니다: 결정론적 스탠드인으로 전체 흐름을 실행하여 자체 동작을 검증하며, API 키도, 실제 기기도, 실제 계정도 필요하지 않습니다. 이것이 "우리가 보증한다"의 검증 가능한 절반입니다 — 명령 하나로 실제로 실행된다는 것을 증명합니다:

```bash
pnpm demo:smart-home-hub          # 홈: 승인→문 잠김 / 거부→문 잠금 해제 유지
pnpm demo:family-learning-hub     # 가족: 화이트리스트 외→부모 승인 / 부모 거부→수업 미진행
pnpm demo:cafe-ops                # 매장: 초과 근무 HITL, 관리자가 금액 결정
pnpm demo:personal-coding-hub     # 코딩: 분업 + 안전 게이트
pnpm demo:personal-research-hub   # 연구: 원자료 → 상호 링크된 wiki
pnpm demo:battle-monk-training    # 성장: 신체/정신/지식 세 기둥
pnpm demo:warband-club            # 클럽: 공유 아카이브 + 대장 확인
pnpm demo:tea-supply-link         # 크로스 조직: 경계를 넘는 주문은 사람 승인 필요
pnpm demo:tea-chain-hq            # 체인: 가격 재조정 출시는 사람 승인 필요
pnpm demo:codex-deepseek-hub      # 코딩 (Codex + DeepSeek)
```

템플릿 자체가 어떻게 파싱되는지 보려면 (로드 미리보기, 키 없음): 위의 것을 `pnpm demo:<name>:template`으로 교체하면 됩니다.

---

## 실제로 사용하기

결정론적 데모는 로직이 작동함을 증명합니다; 플래그십을 실제로 사용하려면 이 경로를 따르세요:

- **원클릭 설치**: admin UI의 "Workflows → Template Gallery"에서 하나를 클릭하면 hub에 설치됩니다 ([`docs/zh/TEMPLATE-GALLERY.md`](../zh/TEMPLATE-GALLERY.md) 참조).
- **개인 / 조직 hub 비교 + 실제 DeepSeek/Obsidian 온보딩**: [`docs/zh/HANDS-ON-HUBS.md`](../zh/HANDS-ON-HUBS.md).
- **라이브 배포 (세 가지 토폴로지)**: [`docs/zh/GO-LIVE.md`](../zh/GO-LIVE.md).
- **크로스 조직 페더레이션 두 머신 런북**: [`docs/zh/FEDERATION-RUNBOOK.md`](../FEDERATION-RUNBOOK.md).
- **가족 학습 두 주권 머신 배포**: [`docs/zh/FAMILY-LEARNING-GO-LIVE.md`](../zh/FAMILY-LEARNING-GO-LIVE.md).

---

## 인용 순위표 (가장 많이 파생된 것)

솔직한 출처 표기가 이 커뮤니티의 유일한 통화입니다. 템플릿을 포크할 때 `provenance.derivedFrom`에 슬러그를 작성하면 — 크레딧이 업스트림으로 흘러갑니다. 아래 표는 "`derivedFrom`을 선언하는 템플릿 수" (인용 횟수 = 인입 차수)로 순위를 매기며, 검증된 템플릿 코퍼스에서 [`pnpm build:leaderboard`](../../packages/web/scripts/build-leaderboard-doc.mjs)에 의해 **결정론적으로 생성**되고, [정적 쇼케이스](../COMMUNITY-SITE.md) 순위표와 동일한 계산 (절대 충돌 없음):

> 참고: 순위표 제너레이터는 현재 중국어 소스 ([`docs/zh/FLAGSHIP-TEMPLATES.md`](../zh/FLAGSHIP-TEMPLATES.md))에 마커를 씁니다. 아래 스냅샷은 그 생성된 표의 수동 미러입니다; 제너레이터가 이 영어 문서를 대상으로 하도록 재배선하는 것은 추적된 후속 작업입니다.

| # | 템플릿 | 인용 횟수 | 파생된 것 |
|---|---|---|---|
| 1 | **개인 코딩 멘토 (Karpathy 워크플로)** (`personal-coding-hub`) | 1 | 페어링 코딩 멘토 (Codex × DeepSeek TUI) |
| 2 | **차 가게 (크로스 조직 공급 링크)** (`tea-supply-link`) | 1 | 차 체인 본사 (크로스 조직 지시 출시) |

> 표는 **생성됩니다**: `derivedFrom` 엣지를 추가한 후 `pnpm build:leaderboard`를 실행하여 소스를 재렌더링하세요. `packages/web/tests/build-leaderboard-doc.test.ts`가 실제 코퍼스와 동기화 상태를 유지하는지 감시합니다 — 직접 편집하거나 재렌더링을 잊으면 테스트에서 감지됩니다. 순위표는 사람이 아닌 **템플릿**의 순위를 매깁니다 — 이것은 보상이나 경제적 인센티브가 아닌 **인정** 인센티브입니다 ([`docs/zh/RECOGNITION-SYSTEM.md`](../RECOGNITION-SYSTEM.md) / [`RECOGNITION-SYSTEM.md`](../ko/RECOGNITION-SYSTEM.md) 참조).

---

## 기여하고 싶으시다면

플래그십은 소수이며 보증됩니다. 대부분의 템플릿은 **커뮤니티 티어**여야 합니다 — 기준은 "라이선스 정리, 파싱 가능, 평문 시크릿 없음, 출처 있음"이지, "우리가 당신의 취향을 보증한다"가 아닙니다. 절차는 [`templates/community/templates/README.md`](../../templates/community/templates/README.md)에 있습니다: 플래그십 복사 → 자신의 것으로 수정 → 출처 선언 (`derivedFrom`) → 로컬에서 `pnpm check:templates` → PR 열기.

솔직한 출처 표기가 이 커뮤니티의 통화입니다: `derivedFrom`은 업스트림으로 크레딧을 흘려보내고, 정적 인용 순위표는 "얼마나 많은 템플릿이 당신에게서 파생되었는가"를 집계합니다. 커뮤니티 티어에서 플래그십으로의 승격은 공개 이슈에서의 유지 관리자 결정입니다 — 기준은 [`GOVERNANCE.md`](../../GOVERNANCE.md)에 있습니다.
