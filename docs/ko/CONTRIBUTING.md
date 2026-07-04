# Gotong 기여 가이드

<!-- doc-version: 1.0 -->
> **문서 버전 1.0** · 한국어 번역 · 최종 업데이트 2026-06-27 · 권위 있는 원본: [English](../../CONTRIBUTING.md). 번역본이 영어 버전과 충돌하는 경우 영어 버전이 우선합니다.

기여를 고려해 주셔서 감사합니다. Gotong는 초기 단계 프로젝트로, 패치, 버그 리포트,
설계 피드백, 문서 개선을 환영합니다 — 그리고 **구축하는 것만큼이나 전파하는 것도
환영합니다**: 동영상, 강연, 튜토리얼, 번역, 지속적인 커뮤니티 지원 모두 [`CONTRIBUTORS.md`](CONTRIBUTORS.md)에
기록되고, 최고의 학습 자료는 [`LEARN.md`](LEARN.md)에 전시됩니다. 두 파일 모두
[인정 시스템](RECOGNITION-SYSTEM.md)의 기둥 ⑤이며, 전파 작업이 구축 작업과 동등한
인정을 받는 이유를 설명합니다.

## 기본 원칙

- **친절하게.** 이슈 트래커 / PR에서 누구든 본인이 힘든 날 시니어
  엔지니어에게 대접받고 싶은 방식으로 대하세요.
- **작은 PR.** 독립적인 변경사항은 거대한 PR보다 빠르게 출시됩니다. 기능이
  깔끔하게 분리된다면 부분별로 나눠서 제출하세요.
- **허브는 단순하게 유지합니다.** Gotong의 설계 원칙은 허브가 라우팅 /
  저장을 하고 에이전트 로직을 소유하지 않는 것입니다. LLM 호출, 에이전트
  루프, 또는 비즈니스 규칙을 허브에 넣는 패치는 방향 수정될 것입니다.
- **와이어 프로토콜은 버전 관리됩니다.** 프로토콜 레벨 메시지 형태를
  변경하는 모든 사항은 `docs/PROTOCOL.md`와 프로토콜 버전 업그레이드를
  거칩니다. 로컬 전용 변경은 해당하지 않습니다.
- **의존성 추가는 사전 논의.** 런타임 의존성(특히 네이티브 의존성)을
  추가하는 것은 실질적인 결정입니다 — 먼저 이슈를 열어 논의하세요.

## 작업 흐름

```bash
# GitHub에서 포크한 후:
git clone git@github.com:<you>/Gotong.git
cd Gotong
pnpm install
pnpm build

# 변경 작업…

pnpm -r typecheck      # 19개 이상의 패키지 타입체크 통과
pnpm -r test           # 패키지 전체 vitest
pnpm test:python       # python-sdk pytest
```

코드 규칙:

- TypeScript 엄격 모드, 상대 경로 임포트에 `.js` 임포트 확장자 사용
  (TypeScript의 "node16/nodenext" 해석 방식에서 필요합니다).
- 테스트는 해당 코드 옆에 위치합니다 (`packages/*/tests/`).
- 린트는 아직 도구로 강제되지 않습니다; 기존 파일의 스타일을 따르세요.
- 커밋 메시지: 명령형 ("add foo"이지 "added foo"가 아닙니다). 비간단한
  커밋에는 한 단락의 설명을 환영합니다.

## 저장소 구조

```
packages/
  core/           Hub + 레지스트리 + 스케줄러 + 트랜스크립트 + Space
  protocol/       와이어 프로토콜 타입 (제로 런타임)
  transport-ws/   허브 측 WebSocket 어댑터
  sdk-node/       원격 에이전트용 Node SDK (connect + AgentParticipant)
  web/            임베드 가능한 웹 서버 + 정적 SPA
  host/           프로덕션 바이너리 (env 구동, 데모 상태 없음)
  llm/            LlmAgent 기본 클래스 + LlmProvider 인터페이스
  llm-anthropic/  Anthropic 제공자
  llm-openai/     OpenAI 제공자
python-sdk/       Python SDK (sdk-node의 미러)
examples/         실행 가능한 데모
docs/             장문 아키텍처 / 프로토콜 / 배포 문서
```

## 기여할 수 있는 영역

시작하기 쉬운 태스크를 원하신다면 `good-first-issue` 라벨의 이슈를
찾아보세요. 항상 환영하는 주제들:

- **문서**: 오탈자, 더 명확한 예시, 번역 (프로젝트에 중국어 사용
  메인테이너가 있습니다; 영문 문서는 아직 얇은 편입니다).
- **테스트 커버리지**: 특히 스케줄러 엣지 케이스와 Space의 온디스크
  마이그레이션 경로.
- **추가 LLM 제공자**: `packages/llm-anthropic`의 형태를 복사하세요.
- **관리자 UI의 접근성 / 국제화**: 바닐라 JS, 프레임워크 없음, 작은
  표면적.

## 템플릿 기여

TypeScript를 작성하지 않아도 기여할 수 있습니다. Gotong는 **템플릿**을
제공합니다 — 누군가가 가져와서 바로 동작하는 허브(에이전트 + 워크플로우 +
지식 베이스 참조, 비밀이나 지식 콘텐츠는 절대 포함되지 않음)를 얻을 수
있는 자체 완결적인 YAML입니다.

- 단일 적응된 프롬프트 → [`templates/community/`](../../templates/community/).
- 전체 가져오기 가능한 허브(다중 에이전트 + 워크플로우) →
  [`templates/community/templates/`](../../templates/community/templates/) —
  해당 README에서 5단계 흐름을 안내합니다: 플래그십 예제 복사, 적응,
  출처 선언 (`derivedFrom`), `pnpm check:templates`로 로컬 검증, PR 열기.

*커뮤니티 템플릿으로 병합되는* 기준(라이선스가 명확하고, 파싱되고, 리터럴
비밀이 없음)은 *플래그십으로 출시되는* 기준(결정론적 데모, 명시된 거버넌스
자세, 유지 관리됨)보다 낮습니다. [`GOVERNANCE.md`](../../GOVERNANCE.md)를
참조하세요.

## 버그 신고

유용한 버그 리포트에는 다음이 포함됩니다:

- 시도한 것 (전체 명령줄, 전체 환경 변수)
- 예상한 것
- 발생한 것 (오류 출력이 있으면 전체, 버그가 라우팅 / 지속성에 있다면
  `transcript.jsonl` 발췌)
- 버전: `node --version`, `pnpm --version`, OS

네트워크 형태 버그(작업자 연결 끊김, 에이전트가 라우팅되지 않음)의 경우,
`/api/state` 스냅샷을 포함하세요 — 이것이 "허브가 어떤 상태라고 생각하는가"의
정식 기록입니다.

## 보안

보안 이슈는 공개 이슈 트래커에 올리면 **안 됩니다**. [`SECURITY.md`](../../SECURITY.md)를
참조하세요.

## 라이선스

기여함으로써 귀하는 자신의 작업을 프로젝트에서 사용하는
[MIT 라이선스](../../LICENSE) 아래 제공하는 것에 동의합니다. CLA 없음.
