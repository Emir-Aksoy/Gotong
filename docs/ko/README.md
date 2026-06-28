# AipeHub

<!-- doc-version: 1.0 -->
> **문서 버전 1.0** · 한국어 번역 · 최종 업데이트 2026-06-27 · 권위 있는 원본: [English](../../README.md). 번역본이 영어 버전과 충돌하는 경우 영어 버전이 우선합니다.

[English](../../README.md) · [中文文档](../../docs/zh/README.md)

**AI + 사람(Person) + 허브(Hub)** — 사람과 AI 에이전트가 동등한 참여자로 협업하고, 조직들이 열쇠, 데이터, 청구를 넘기지 않고 연합하는 자체 호스팅 기반 기술.

AipeHub는 에이전트가 아니며 — 또 다른 에이전트 프레임워크도 아닙니다. AipeHub는 그것들 **아래에 있는 계층**입니다: 레지스트리, 메시지 버스, 태스크 라우터, 관리되는 연합 링크, 그리고 추가 전용 트랜스크립트. LangGraph / CrewAI 에이전트, CLI 코딩 에이전트(Claude Code, Codex), 그리고 사람 모두 동일한 `Participant`로 연결됩니다. 허브는 신호가 흐르게 하고 경계를 강제합니다 — LLM을 직접 실행하지 않으므로, 모든 결정은 참여자들에게 남습니다.

### 중요한 것을 실제로 신뢰할 수 있는 AI

대부분의 AI 도구는 두 가지 옵션을 제공합니다: 통제하지 않는 클라우드에 모든 것을 넘기거나, 직접 모든 것을 연결하거나. AipeHub는 세 번째 옵션입니다 — **집, 가족, 또는 돈을 향해 겨냥할 수 있는 AI, 왜냐하면 경계가 실재하고 당신 것이기 때문입니다:**

- **중요한 곳에 사람이 개입합니다.** 가역적인 행동(불 끄기)은 그냥 발생합니다; 비가역적인 것들(문 잠그기, 돈 쓰기, 아이의 데이터를 링크 통해 보내기)은 받은 편지함에서 사람이 확인할 때까지 기다립니다. 워크플로우는 게이트를 건너뛸 수 없습니다.
- **열쇠와 데이터는 디스크에 남습니다.** 자격증명은 당신 자신의 `.aipehub/` 디렉토리에 암호화되어 저장됩니다. 다른 허브와 연합하면 능력을 공유하지, 볼트는 공유하지 않습니다.
- **어둠 속에서 결정하지 않습니다.** 모든 디스패치와 결과는 당신이 읽을 수 있는 추가 전용 트랜스크립트입니다. 프레임워크는 모델을 실행하지 않으므로, 숨겨진 판단이 없습니다.

→ [**플래그십 템플릿**](../../docs/zh/FLAGSHIP-TEMPLATES.md)에서 비기술적인 사람이 오늘 가져와서 실행할 수 있는 허브들을 확인하세요(스마트 홈, 카페 운영, 가족 학습 허브, 개인 코딩 허브), 각각 거버넌스 게이트가 명확하게 보이고 원 커맨드 데모가 있습니다. 직접 공유하고 싶은 것이 있으신가요? [`templates/community/templates/`](../../templates/community/templates/).

## 핵심 아이디어

- **허브는 의도적으로 단순합니다.** LLM을 실행하거나 에이전트 루프를 소유하지 않습니다. 메시지를 라우팅하고, 태스크를 디스패치하고, 트랜스크립트를 유지하고, 이벤트를 내보냅니다. 결정은 참여자들에게 남습니다.
- **사람이 일급 시민입니다.** 사람은 에이전트처럼 `Participant`입니다. 허브의 비동기 / 장기 실행 프리미티브가 둘 모두에 적용됩니다.
- **하나의 인터페이스, 두 가지 배포 형태.** 에이전트들은 인-프로세스로 실행되든 네트워크를 통해 실행되든 동일한 `Participant` 계약을 구현합니다. 로컬 및 원격 에이전트는 동일한 레지스트리와 동일한 스케줄러를 공유합니다.
- **플러그형 스케줄링.** 기본 제공 세 가지 태스크 라우팅 전략: 명시적 할당, 능력 매칭, 브로드캐스트 클레이밍.
- **자신의 LLM을 가져오세요.** 작은 `LlmAgent` 기본 클래스 + 중립적인 `LlmProvider` 인터페이스를 통해 Hub를 건드리지 않고 Claude, GPT 또는 다른 모델로 에이전트를 지원할 수 있습니다.

## 현재 상태

**자체 호스팅, 파일 우선, 다중 조직 사용을 위해 관리됩니다.** 워크스페이스는 디스크의 디렉토리입니다(`.aipehub/`) — 디렉토리를 삭제하면 공간이 사라지고; 복사하면 팀원에게 방을 넘겨준 것이며; 재시작은 투명합니다. 그 위에: 조직별 자격증명 볼트, 링크별 신뢰 계약(능력 화이트리스트 · 데이터 클래스 게이트 · 할당량 · 취소)을 통한 크로스 조직 연합, human-in-the-loop 승인 받은 편지함, 그리고 사용량 / 비용 원장. 허브는 여전히 LLM을 실행하지 않습니다 — 모든 결정은 참여자들에게 남습니다.

npm 패키지들은 `@aipehub/*`로 범위가 지정됩니다; Python SDK는 PyPI에서 `aipehub`입니다. 라이선스: [MIT](../../LICENSE).

## 입구 선택

> **길을 잃으셨나요?** [`docs/OVERVIEW.md`](../../docs/OVERVIEW.md)에서 시작하세요 — 사용법, 라이선스, 에이전트 온보딩, 템플릿 다운로드, 다중 사용자 팀, 다중 팀 연합을 하나의 서사로 묶은 단일 페이지입니다. 아래 표는 역할별 세부 내용입니다.

| 당신은… | 읽을 것 | 요약 |
|---|---|---|
| 🧭 **처음 오신 분** | [`docs/OVERVIEW.md`](../../docs/OVERVIEW.md) | 모든 개념의 5분 지도 + "소규모 팀 워크플로우" 워크스루. |
| 🧑 **방에 입장하는 작업자 / 관리자** | [`docs/HUMAN.md`](../../docs/HUMAN.md) | 운영자가 준 URL을 여세요; 닉네임을 선택하세요; 입장하셨습니다. |
| 🤖 **연결할 에이전트 작성 중** | [`docs/AGENT.md`](../../docs/AGENT.md) | `@aipehub/sdk-node` 또는 Python `aipehub`. `AgentParticipant`를 서브클래스화하세요. |
| 🧩 **코드 없이 LLM 에이전트 연결** | [`docs/TEMPLATES.md`](../../docs/TEMPLATES.md) + [`templates/`](../../templates/) | YAML 매니페스트 → 관리자 UI에 붙여넣기 / 업로드 → 호스트가 생성. 두 세트: 프로젝트 원본(`templates/agents/`) 및 CC0/MIT 커뮤니티 적응(`templates/community/`). |
| ⭐ **유용한 것을 하는 허브를 원할 때** | [`docs/zh/FLAGSHIP-TEMPLATES.md`](../../docs/zh/FLAGSHIP-TEMPLATES.md) (zh) | 큐레이션된, 신뢰 프레임된 갤러리 — 하나 가져오면 작동합니다. 스마트 홈, 카페 운영, 가족 학습, 개인 코딩. 각각 무엇을 건드릴 수 있고 없는지 + 무키 데모를 보여줍니다. |
| 🔧 **서버 운영 중** | [`docs/DEPLOY.md`](../../docs/DEPLOY.md) | 로컬은 `pnpm host`, 공개는 Caddy + systemd. |
| 🚀 **라이브 전환 (3가지 토폴로지)** | [`docs/zh/GO-LIVE.md`](../../docs/zh/GO-LIVE.md) + [`deploy/`](../../deploy/) | 홈 호스트 + IM, 클라우드 호스트 + IM, 또는 클라우드 + 직접 IP. `deploy/.env.home` / `.env.cloud` 복사, 런북을 따르세요. IM 브리지는 아웃바운드 롱폴이므로 → NAT된 홈 박스는 터널이 필요 없습니다. (런북은 zh; 영문 예정.) |
| 🪢 **두 허브 연합 (팀 → 조직)** | [`docs/FEDERATION.md`](../../docs/FEDERATION.md) | `TeamBridgeAgent`가 전체 서브 허브를 업스트림에서 하나의 에이전트로 나타나게 합니다 — 내부 멤버 / 키 / 서브 태스크를 비공개로 유지합니다. |
| 🔌 **Claude Desktop / Cursor / Cline에서 Hub 구동** | [`docs/MCP.md`](../../docs/MCP.md) | `@aipehub/mcp-server`는 MCP 브리지입니다 — 5가지 도구(목록 / 디스패치 / 평가 / 리더보드 / 태스크). MCP 클라이언트 설정에 5줄을 추가하세요. |
| 🧰 **에이전트에 MCP 도구 생태계 제공** | [`docs/MCP.md`](../../docs/MCP.md#6-outbound--using-third-party-mcp-tools-from-your-agent) | `@aipehub/mcp-client`를 통해 AipeHub 에이전트가 Filesystem / GitHub / Slack / Postgres / 모든 MCP 서버를 연결할 수 있습니다. `LlmAgent`는 기본적으로 멀티턴 도구 사용 루프를 실행합니다(v0.3+) — `tools: toolset`을 전달하기만 하면 Claude / GPT가 어떤 도구를 언제 호출할지 결정합니다. |
| ⚖️ **라이선스 / 상업적 사용 걱정** | [`docs/LICENSE-FAQ.md`](../../docs/LICENSE-FAQ.md) | 전체적으로 MIT. 폐쇄 소스 / SaaS에 임베드 가능. 커뮤니티 템플릿은 CC0 + MIT. |
| 🧠 **그 위에서 설계 중** | [`docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md) + [`docs/PROTOCOL.md`](../../docs/PROTOCOL.md) | 허브는 의도적으로 단순합니다; 와이어 프로토콜은 v1.0. |
| 📊 **배포 크기 산정** | [`docs/PERFORMANCE.md`](../../docs/PERFORMANCE.md) + [`docs/zh/CLOUD-RESOURCE-FOOTPRINT.md`](../../docs/zh/CLOUD-RESOURCE-FOOTPRINT.md) | 사전 런칭 기준 수치 + 자체 하드웨어에서 부하 테스트를 재실행하는 방법. zh 문서는 **실제 프로덕션 측정**(Feishu + MiMo, 2 vCPU / 2 GiB 박스의 단일 허브)을 부하별 용량 추정치 및 업그레이드 트리거와 함께 추가합니다 — 추론이 호스트가 아닌 LLM 제공자에서 실행되기 때문에 안정 상태는 ~110–160 MiB RAM 및 ~0 CPU입니다. |
| 🛟 **프로덕션 운영** | [`docs/OPERATIONS.md`](../../docs/OPERATIONS.md) | 백업/복원 플레이북, 재해 복구 드릴, `secret.key` 처리, 문제 해결. |
| 📡 **모니터링 + 알림** | [`docs/MONITORING.md`](../../docs/MONITORING.md) | Prometheus 스크랩 설정, 런북이 있는 7개의 알림 규칙, Grafana 대시보드 JSON. |

### 에이전트 추가 — 두 가지 경로

|  | 호스트 관리 (코드 없음) | 외부 SDK (자체 코드) |
|---|---|---|
| **당신이 할 일** | 관리자 UI에서 YAML 매니페스트 붙여넣기 / 업로드 | `AgentParticipant.handleTask` 작성, `connect(url, agents)` 호출 |
| **실행 위치** | 허브 프로세스 내부(LocalAgentPool) | 네트워크 어디서든 |
| **할 수 있는 것** | Anthropic / OpenAI / Mock 제공자를 통한 LLM 태스크 | 무엇이든 — LLM, 스크레이퍼, 비공개 데이터, ML 모델, 스크립트 |
| **API 키 위치** | `.aipehub/secrets.enc.json`에 암호화됨(에이전트별 또는 워크스페이스 기본값) | 코드가 읽는 곳 어디든 |
| **재시작 시** | `LocalAgentPool`이 자동으로 재생성 | 코드가 다시 연결(SDK에 자동 재시도 내장) |
| **최적 사용** | 최종 사용자 • 표준 역할 • 원클릭 템플릿 | 개발자 • 비공개 로직 • 크로스 언어 작업자 |
| **읽기** | [`docs/TEMPLATES.md`](../../docs/TEMPLATES.md) | [`docs/AGENT.md`](../../docs/AGENT.md) |

두 경로 모두 동일한 허브에 연결됩니다. 자유롭게 혼합하세요 — 방에는 호스트 관리 `writer-zh`와 자체 SDK 연결 `rag-agent`가 나란히 있을 수 있습니다.

이 프로젝트가 무엇이며 — 무엇이 되기를 거부하는지: [`CHARTER.md`](../../CHARTER.md). 기여하시겠습니까? [`CONTRIBUTING.md`](../../CONTRIBUTING.md) 참조. 보안 문제: [`SECURITY.md`](../../SECURITY.md). 버전 히스토리: [`CHANGELOG.md`](../../CHANGELOG.md).

## 빠른 시작

### 비기술적 사용자? 더블클릭, Node/Docker 없음

실행하는 기기에 **터미널도, Node도, Docker도 필요 없는** 경로. 유지관리자가 자체 포함된 포터블 번들을 한 번 빌드합니다:

```bash
node scripts/build-portable.mjs        # → dist-portable/AipeHub-macos-arm64/
```

그러면 전체 `AipeHub-macos-arm64/` 폴더를 누구에게든 건네주세요. **`AipeHub.command`를 더블클릭**하면 → 브라우저가 5분 설정 마법사를 엽니다. 번들은 자체 핀된 Node 런타임 + 컴파일된 호스트 + 실제 온디스크 `node_modules`(네이티브 SQLite 바인딩 포함)를 제공하므로, 아무것도 설치되지 않은 기기에서도 **전체** 아이덴티티 지원 호스트를 실행합니다. 데이터는 `~/.aipehub`에 저장되므로(폴더 외부), 번들을 교체해도 데이터가 손실되지 않습니다.

아직 커밋/게시된 다운로드는 없고 주문형 빌드입니다(그것이 1.0 이후 계획) — 지금은 "다운로드 & 실행"이 *폴더를 한 번 빌드하고, 폴더를 공유*를 의미합니다. 이번 라운드는 macOS arm64. 전체 설명: [`docs/zh/PORTABLE-BUNDLE.md`](../../docs/zh/PORTABLE-BUNDLE.md).

### 30초 안에 실행 — 하나 선택

```bash
# A. Docker (권장 — Node 설정 없음, macOS / Windows / Linux에서 작동)
docker compose up
# → http://127.0.0.1:3000  + 로그에 관리자 URL 출력
# → ./data 아래에 상태 유지

# B. 소스에서 (복제된 저장소, 전체 데모 세트 사용 가능)
pnpm install
pnpm build
pnpm host
```

둘 다 동일한 바이너리를 부팅합니다. 출력된 관리자 URL을 열고 → 토큰을 저장하면 → 완료됩니다.

**첫 실행 편의 기능 (신규).** 부팅 후 호스트는 루프백 설정 마법사를 가리키는 두드러진 다음 단계 배너를 출력하며, 로컬(루프백) 첫 실행 시 브라우저를 자동으로 엽니다:

```text
┌─ 下一步 / Next step ──────────────────────────

  打开浏览器完成 5 分钟设置 (设置向导,无需 token):
  Open your browser to finish the 5-minute setup:

      →  http://127.0.0.1:3000

  设置向导在本机回环 (loopback) 上运行。
  The setup wizard runs on loopback only.
└───────────────────────────────────────────────
  (已自动打开浏览器 / browser opened — AIPE_OPEN_BROWSER=0 关闭)
```

`AIPE_OPEN_BROWSER`가 자동 열기를 제어합니다: 설정 안 됨 = `auto`(첫 번째 로컬 실행만), `1`/`always` = 매 시작, `0`/`never` = 끄기. 호스트가 네트워크에 노출될 때마다 강제로 끕니다 — 헤드리스 서버는 브라우저를 팝업하지 않으며, 마법사도 거기서 접근할 수 없습니다(그 경로는 관리자 토큰 파일을 사용합니다). 배너 자체는 항상 출력됩니다.

> 💡 **배포.** 이 단계에서는 `npm publish` 없음 — Docker(A)와 소스(B)가 두 가지 지원 설치 경로입니다. 이전의 "v2.1 대기열" npm 계획은 **범위에서 제외**되었습니다; 레지스트리 선택(npm / JSR / 소스 전용)은 [RELEASE-CHECKLIST](../../.github/RELEASE-CHECKLIST.md)에서 추적 중인 열린 결정입니다. macOS / Windows용 사전 빌드된 단일 파일 바이너리는 계획되었지만 비블로킹 항목입니다 — Docker가 이미 "클릭 및 실행" 크로스 플랫폼 케이스를 다룹니다.

빌드된 저장소에서 CLI 플래그:

```bash
pnpm exec aipehub-host --help       # 전체 환경 변수 참조
pnpm exec aipehub-host --version    # 현재 호스트 버전
```

부팅 후, "이제 무엇을" 워크스루를 위해 [`docs/OVERVIEW.md`](../../docs/OVERVIEW.md)를 따르세요.

**시작이 안 되나요?** 부팅 전에 사전 점검을 실행하세요 — 호스트가 읽는 정확한 `AIPE_*` env를 검사합니다(Node 버전, 실제로 바인딩 가능한 포트, 데이터 디렉토리 쓰기 가능, 마스터 키)하고 각 검사별로 ✓ / ⚠ / ✖과 한 줄 수정을 출력합니다:

```bash
pnpm exec aipehub doctor          # 보고만
pnpm exec aipehub doctor --fix    # 또한 누락된 데이터 디렉토리 자동 생성(유일한 안전하고 가역적인 수리)
```

그리고 부팅이 *실패*하면, 호스트는 일반적이고 복구 가능한 실패(포트 이미 사용 중, 포트 바인딩 권한 없음, 마스터 키 없음/유효하지 않음, 데이터 디렉토리 쓰기 불가, 디스크 가득 참)를 변경할 `AIPE_*` 변수를 명명하는 한 줄 인간 메시지로 전환합니다 — 스택 트레이스가 아닙니다. [`docs/zh/GO-LIVE.md`](../../docs/zh/GO-LIVE.md) §十一의 문제 해결 섹션을 참조하세요.

**키 프로브가 작동하는지 확인(실제 키 불필요).** 가장 흔한 첫 실행 함정은 붙여넣은 LLM 키가 조용히 작동하지 않는 것입니다. 설정 마법사는 원클릭 "go add a key" 구조 경로로 이것을 잡습니다; 이 명령은 온보딩 전에 구조 경로가 연결되어 있다는 것을 알 수 있도록 동일한 프로브를 처음부터 끝까지 실행합니다:

```bash
pnpm check:onboarding          # hermetic — 잘못된/빈 키 → "키 추가로 이동", 네트워크 오류 → "URL 확인"을 증명
ANTHROPIC_API_KEY=… pnpm check:onboarding   # 또한 실제 키를 와이어를 통해 왕복(옵트인; 없으면 건너뜀)
```

기본적으로 hermetic(네트워크 없음, 지출 없음)이며 키를 로그에 기록하지 않습니다. 종료 0 = 실행된 모든 검사 통과. 옵트인 실제 키 검사는 라이브 게이트의 env 계약(`OPENAI_API_KEY` + `OPENAI_BASE_URL=https://api.deepseek.com` + `AIPE_LIVE_OPENAI_MODEL=deepseek-chat` for the DeepSeek path)을 미러링합니다.

### 클라우드 서버(VPS)에 배포

새 Ubuntu/Debian 박스가 있으신가요? 체크아웃을 거기에 올리고(`git clone` 키와 함께, 또는 `scp`로 — 저장소는 비공개이므로 공개 풀이 없습니다), 그러면 하나의 명령으로 systemd 서비스를 프로비저닝하세요:

```bash
# 체크아웃 내부, VPS에서
sudo bash deploy/cloud-quickstart.sh        # Node+pnpm 설치 → 빌드 → 사용자+유닛
#   먼저 미리보기, 변경하지 않음:  bash deploy/cloud-quickstart.sh --dry-run
```

Node + pnpm을 설치하고, 빌드하고, `aipehub` 서비스 사용자와 데이터 디렉토리를 만들고, `/etc/aipehub.env`를 드롭하고([`deploy/.env.cloud`](../../deploy/.env.cloud)에서), [`docs/zh/DEPLOY.md`](../../docs/zh/DEPLOY.md) §C.4를 미러링하는 systemd 유닛을 설치합니다. **시작 한 단계 전에 멈춥니다** — env 파일은 도메인 / 마스터 키 / 호스트 허용 목록이 비어 있고, 구성되지 않은 박스를 노출하는 것은 안전하지 않습니다. 안전한 마지막 단계를 출력합니다: env를 채우고, [`scripts/cloud-harden.sh`](../../scripts/cloud-harden.sh)를 실행하고(경계 검사), Caddy + 방화벽을 앞에 두고, 그런 다음 `systemctl enable --now aipehub`.

> 저장소가 비공개인 동안에는 **브라우저 "원클릭 배포" 버튼이 없습니다**(그것들은 공개 저장소 또는 git에 미리 연결된 제공자 계정이 필요합니다). 이 복사 붙여넣기 부트스트랩이 실제적이고 테스트 가능한 동등물입니다. 전체 런북 — 토폴로지, IP 노출 위험, IM 멤버 온보딩: [`docs/zh/GO-LIVE.md`](../../docs/zh/GO-LIVE.md).

### 个人模式 (신규, v4 Phase 7) — 혼자 AI로 작업하기, 0 설정

혼자 사용하고 AipeHub를 "나의 AI 데스크탑"으로 사용하고 싶다면(팀 허브가 아닌),
`docker compose up`만 하면 됩니다 — 호스트가 첫 번째 시작 시 사용자가 한 명뿐임을 감지하면,
**자동으로 개인 모드로 진입합니다**:

```bash
docker compose up
# → http://127.0.0.1:3000/admin?token=<printed>
# → 첫 화면 상단에 "owner" 역할 칩이 없음(개인 사용자는 조직 역할을 볼 필요 없음)
# → 부제목은 "나의 AI 데스크탑"(관리자 콘솔이 아닌)
# → 설정 탭에 [팀 모드로 업그레이드] 버튼 등장 — 언젠가 사람을 초대하고 싶을 때 클릭
```

개인 모드와 팀 모드의 차이는 두 가지입니다:
- 홈페이지 부제목 텍스트 다름 / 역할 칩 숨김
- 설정에 업그레이드 버튼 추가

**모든 관리자 탭은 여전히 있습니다**(사용자 관리 / peer / 할당량 / 감사 모두 보임),
하지만 이런 개념들이 화면을 채우지 않습니다. 필요할 때 사용하세요.

`AIPE_MODE=team`으로 팀 모드를 강제 고정할 수 있습니다(사용자가 한 명뿐이더라도);
`AIPE_MODE=personal`은 반대 — 다중 사용자일 때도 개인 모드 강제 고정(드문 케이스,
일반적으로 dev / 테스트 시나리오에서 사용).

팀으로 업그레이드 후, 자동으로 "사용자 초대" 흐름이 나타납니다, 그런 다음 팀 멤버에게 관리자 URL을 내보내세요;
경로는 아래 5분 개인 성장 워크플로우 또는 [`docs/zh/OVERVIEW.md`](../../docs/zh/OVERVIEW.md)를 참조하세요.

### 5분 개인 성장 워크플로우 (신규)

첫 번째 즉시 실행 가능한 기본 제공 경험. 7명의 코치(인터뷰 + 신체 / 심리 / 목표 / 자원 / 관계 + 종합 기획자)를 한 번 실행하면 → 12주 벽 계획이 디스크에 markdown으로 저장됩니다. 기본 LLM은 **DeepSeek**(국내 접근 가능, 저렴)입니다.

```text
1. 호스트 설치(Docker 또는 소스, 위 참조)
2. 출력된 관리자 URL 열기 → 관리자로 이동
3. DeepSeek API 키 신청: https://platform.deepseek.com(신규 사용자에게 10위안 크레딧 제공, 수십 번 실행 가능)
4. 관리자 → 워크플로우 탭 → [팀 가져오기(번들)] 클릭 → [🎁 내장 템플릿 사용: 개인 성장] 클릭
   → DeepSeek 키 붙여넣기 → [가져오기]
   (7개 에이전트가 원클릭으로 생성, 워크플로우가 자동으로 등록됨)
5. 워크플로우 카드에서 [시작] 클릭 → 4단계 양식 팝업(현재 상태 / 바람 / 막힘 / 이번에 가장 명확히 하고 싶은 것)
6. 디스패치 → ~3.5분 대기(7번의 DeepSeek API 호출)
7. 워크플로우 탭 아래로 스크롤 → "성장 보고서" 패널 → [다운로드] 클릭
   또는: <space>/services/artifact/file/agent/growth-synthesist/reports/<caseId>/<date>.md
```

보고서에는: 프로필 + 신체/심리/목표/자원/관계 5가지 차원 분석 + 한 줄 개발 경로 + **12주 벽 계획**(주선 + 부선, 매주 무엇을 할지) + **5가지 절충 판단** + "못하면 어떻게" 다운그레이드 방안 + "v2 워크플로우 실행 시 답하도록 권장하는 5가지 시드 질문"(다음번에 사용)이 포함되어 있습니다.

> 🙏 **개인정보 / 데이터에 대해**: 당신의 4단계 자술서는 추론을 위해 DeepSeek(중국 본토 서버)에 전송됩니다. 워크플로우 실행 후, 모든 출력은 자체 컴퓨터의 `.aipehub-*/services/` 디렉토리에 저장되고, 클라우드에 업로드되지 않습니다. 각 코치는 경계 있는 동반자로 설계되었습니다 — 신체 코치가 레드 플래그(지속적인 흉통 / 원인 불명의 출혈 등)를 발견하면 의사를 찾도록 안내합니다; 심리 코치가 위험 신호를 발견하면 24시간 위기 핫라인을 제공합니다(전국 400-161-9995 / 말레이시아 Befrienders 03-7956 8144). **이것은 의사 / 심리 상담사 / 재정 고문 / 관계 치료사의 대체품이 아닙니다.**

Anthropic Claude 또는 OpenAI로 전환하고 싶으신가요? `templates/teams/personal-growth-team.yaml`을 편집하고, 각 에이전트의 `provider` / `baseURL` / `model`을 변경하면 됩니다 — 시스템 프롬프트는 벤더와 무관합니다.

### 로깅

구조화된 로깅은 **기본적으로 켜져 있습니다** — stdout이 파이프될 때 이벤트당 JSON 라인(`jq` / Loki / ELK / Datadog용), stdout이 터미널일 때 예쁘게 출력됩니다. 세 가지 환경 변수가 제어합니다:

```bash
AIPE_LOG_LEVEL=info       # silent | trace | debug | info (기본값) | warn | error | fatal
AIPE_LOG_FORMAT=json      # json | pretty (기본값: TTY에 의해 자동)
AIPE_LOG_DISABLED=1       # 하드 오프 탈출구
```

JSON 출력을 얻은 후 `jq`로 컴포넌트별 필터링:

```bash
pnpm host 2>&1 | jq 'select(.comp == "local-agents")'
```

### 데모 (복제된 저장소)

`pnpm install && pnpm build`를 완료하면, 프레임워크의 모든 협업 패턴에 실행 가능한 데모가 있습니다:

```bash
# 인-프로세스 데모 (네트워크 없음)
pnpm demo                # 두 개의 목 에이전트 + 하나의 목 사람
pnpm demo:broadcast      # 세 명의 검토자가 경쟁, 패자 취소됨

# 지속성 데모
pnpm demo:persist:fresh && pnpm demo:persist:resume
pnpm demo:persist:sqlite:fresh && pnpm demo:persist:sqlite:resume

# 원격 에이전트
pnpm demo:remote         # 별도 프로세스의 호스트 + 작업자
pnpm demo:remote:python  # Node 호스트 + Python 작업자(크로스 언어)
pnpm demo:cli-human      # 터미널-인간 승인 루프

# LLM 지원 에이전트
pnpm demo:llm            # LlmAgent + 목 제공자(API 키 불필요)
pnpm demo:llm:real       # 실제 Claude/GPT(ANTHROPIC_API_KEY/OPENAI_API_KEY 필요)

# v2.0 전체 스택 — web UI + 에이전트 승인 + 태스크 패널
pnpm demo:open-space
pnpm demo:federated-team # 하나의 허브가 다른 허브에 단일 에이전트로 합류
```

### 上手案例 — 5개의 즉시 사용 가능한 허브 (Hands-on hubs)

위의 패턴 데모 외에도, 다섯 가지 `examples/` 케이스는 **완전하고 복사 가능한 허브**입니다 —
각각 결정론적 무키 데모 *및* 원파일 로드 가능 템플릿(에이전트 + 워크플로우 + KB 배선)을 제공합니다.
세 개인("나의 AI 데스크탑"), 두 조직(팀 모드):

```bash
# 개인 허브(라우터 LLM이 서브 에이전트 / CLI 조율)
pnpm demo:personal-coding-hub      # 공유 저장소에서 Claude Code + Codex 라우팅
pnpm demo:personal-research-hub    # 원시 소스를 연결된 Obsidian wiki로 컴파일
pnpm demo:battle-monk-training     # 지속적인 Codex에 상태를 작성하는 성장 코치

# 조직 허브(선언적 워크플로우 + surface.me 셀프 서비스 + human: HITL 승인)
pnpm demo:cafe-ops                 # 奶茶/咖啡店: 온보딩 / 교대 / 초과근무, 매니저 승인
pnpm demo:warband-club             # 하나의 공유 아카이브에서 협업하는 팬 클럽
```

하나를 선택하고, 결정론적 데모를 보고, 그런 다음 실제 DeepSeek + Obsidian으로 라이브로 이동하세요 —
전체 카탈로그와 라이브 런북은 **[`docs/zh/HANDS-ON-HUBS.md`](../../docs/zh/HANDS-ON-HUBS.md)**에 있습니다.

## 임베디드 — 하나의 프로세스에 모든 것

```ts
import { Hub, Space } from '@aipehub/core'

// v2.0: 디렉토리에 바인딩; 관리자, 작업자, 트랜스크립트 모두 여기에 저장
const { space, adminToken } = await Space.openOrInit('.aipehub', {
  name: 'my-space',
  adminDisplayName: 'Operator',
})
console.log(`Admin URL once: http://localhost:3000/admin?token=${adminToken}`)

const hub = new Hub({ space })
await hub.start()
hub.register(new MyAgent())
hub.register(new MyHumanAdapter())

const result = await hub.dispatch({
  from: 'admin',
  strategy: { kind: 'capability', capabilities: ['draft'] },
  payload: { topic: 'why TypeScript' },
})

// 테스트 / 지속성 없는 인-프로세스 데모의 경우:
const tmp = Hub.inMemory()
```

## 분산 — 다른 프로세스 / 기기에서 에이전트 연결

호스트 프로세스(허브):

```ts
import { Hub } from '@aipehub/core'
import { serveWebSocket } from '@aipehub/transport-ws'

const hub = new Hub()
await hub.start()
await serveWebSocket(hub, { port: 4000 })
```

작업자 프로세스(모든 에이전트, 어디서든):

```ts
import { AgentParticipant, connect } from '@aipehub/sdk-node'

class MyAgent extends AgentParticipant {
  constructor() { super({ id: 'a1', capabilities: ['draft'] }) }
  protected async handleTask(task) { return { text: '…' } }
}

await connect({ url: 'ws://hub.example.com:4000', agents: [new MyAgent()] })
```

허브의 `dispatch(...)`는 원격 에이전트에 로컬과 동일하게 도달합니다. 와이어 형식은 [docs/PROTOCOL.md](../../docs/PROTOCOL.md)를 참조하고, 실행 가능한 두 프로세스 데모는 [examples/remote-agent](../../examples/remote-agent)를 참조하세요.

## LLM 지원 에이전트

허브는 LLM을 호출하지 않습니다. `LlmAgent`가 합니다 — 태스크를 `LlmProvider`에 연결하고 응답을 `TaskResult`로 전환하는 얇은 기본 클래스입니다. 벤더 교체는 한 줄 변경입니다.

```ts
import { Hub } from '@aipehub/core'
import { LlmAgent } from '@aipehub/llm'
import { AnthropicProvider } from '@aipehub/llm-anthropic'
import { OpenAIProvider } from '@aipehub/llm-openai'

const hub = new Hub()
await hub.start()

// Claude가 초안 작성
hub.register(new LlmAgent({
  id: 'writer',
  capabilities: ['draft'],
  provider: new AnthropicProvider(),        // ANTHROPIC_API_KEY 읽기
  system: 'You write one terse sentence.',
}))

// GPT가 검토
hub.register(new LlmAgent({
  id: 'reviewer',
  capabilities: ['review'],
  provider: new OpenAIProvider(),            // OPENAI_API_KEY 읽기
  system: 'You return one revision suggestion.',
}))

const draft = await hub.dispatch({
  from: 'system',
  strategy: { kind: 'capability', capabilities: ['draft'] },
  payload: { topic: 'distributed agents' },
})
```

`buildRequest(task)`를 오버라이드하여 프롬프트 어셈블리(검색된 컨텍스트, 퓨샷 예시)를 커스터마이즈하거나, `parseResponse(response, task)`를 오버라이드하여 후처리(JSON 추출, 검증 재프롬프트)를 합니다. 전체 제어를 위해 `handleTask(task)`를 오버라이드 — 멀티스텝 추론, 재시도, 구조화된 출력. [`packages/llm`](../../packages/llm/src/agent.ts) 및 [`examples/llm-mock`](../../examples/llm-mock)와 [`examples/llm-real`](../../examples/llm-real)의 두 데모를 참조하세요.

## 오픈 스페이스 — 관리자, 작업자, 에이전트가 한 방에 (v2.0)

허브를 `.aipehub/` 디렉토리에 고정합니다; 관리자 아이덴티티, 작업자 계정, 게이팅된 에이전트 승인이 모두 거기에 저장됩니다. 웹 UI는 두 뷰로 분리됩니다(`/` 작업자, `/admin` 관리자). 허브 재시작은 투명합니다 — 쿠키는 여전히 작동하고, 관리자는 여전히 관리자이며, 트랜스크립트는 재시작이 아닌 성장합니다.

```ts
import { Hub, Space } from '@aipehub/core'
import { serveWebSocket } from '@aipehub/transport-ws'
import { serveWeb } from '@aipehub/web'

const { space, adminToken } = await Space.openOrInit('.aipehub', {
  name: 'my-space',
  adminDisplayName: 'Operator',
  config: { gating: 'admin-approval' },
})
console.log(`Admin URL once: http://localhost:3000/admin?token=${adminToken}`)

const hub = new Hub({ space })
await hub.start()

await serveWebSocket(hub, { port: 4000, gating: (await space.config()).gating })
await serveWeb(hub, { port: 3000 })
// admin = /admin?token=<TOKEN>   |   worker = /
```

- **관리자**는 토큰으로 한 번 로그인하고, 그런 다음 방을 운전합니다: 보류 중인 에이전트 승인을 승인 / 거부하고, 세 가지 전략 중 하나로 태스크를 디스패치하고, 실패한 행에 **재시도** 버튼이 있는 필터 가능한 패널에서 모든 태스크를 보고, 특정 태스크에 첨부된 평가를 작성합니다.
- **작업자**는 `/`에서 닉네임 + 능력을 선택하고, `HumanParticipant`가 됩니다. `workers.json` 행 + HttpOnly 쿠키가 리로드 및 재시작 후에도 기억합니다.
- **에이전트**는 WebSocket 포트에 연결합니다; `gating: 'admin-approval'`에서는 관리자가 행동할 때까지 보류 중에 걸립니다.

[`examples/open-space`](../../examples/open-space)에서 실행 가능한 전체 데모. `pnpm demo:open-space`는 하나의 터미널에서 호스트 + 에이전트를 스핀업하고, 그런 다음 출력되는 두 URL에 브라우저를 가리키세요.

## 허브 서비스 — 에이전트 메모리, 아티팩트, 데이터스토어 (v2.2)

에이전트는 호스트가 대신 유지하기를 원하는 상태를 선언할 수 있습니다. 오늘 세 가지 퍼스트파티 "서비스"가 제공됩니다; 배관은 처음부터 플러그인이므로 네 번째를 추가하는 것은 별도의 npm 패키지입니다.

```yaml
# templates/agents/industry-coach-with-memory.yaml
schema: aipehub.agent/v1
agent:
  id: industry-coach
  capabilities: [intake]
  provider: anthropic
  model: claude-opus-4-7
  system: |
    Use memory.recall before answering; artifact.write the report
    afterwards; cases.sql for structured industry comparisons.
  uses:
    - { type: memory,    impl: file,   config: { kinds: [episodic, semantic] } }
    - { type: artifact,  impl: file,   config: { name: industry-reports } }
    - { type: datastore, impl: sqlite, config: { name: cases, schema: "..." } }
```

스폰 시 호스트는 각 `uses:` 항목을 에이전트가 `ctx.memory`, `ctx.artifact`, `ctx.datastore.<name>`에서 읽는 타입된 핸들로 해결합니다.
소유자 기반 격리가 기본입니다 — `memory:file`을 요청하는 두 에이전트는 두 개의 다른 스토어를 받습니다. 데이터 레이아웃은 `<space>/services/` 아래에 있습니다:

```
<space>/services/
├─ plugins.json                    # 로드할 플러그인(자동 시딩)
├─ memory/file/agent/<agentId>/    # (플러그인, 소유자)당 하나의 디렉토리
├─ artifact/file/agent/<agentId>/
└─ datastore/sqlite/agent/<agentId>/<name>.sqlite
```

소프트 삭제는 관리자 "서비스 / Services" 탭에서 클릭 한 번; 데이터는 플러그인별 `.trash/`로 이동하고, 30일 동안 유지되다가 백그라운드 스위퍼가 하드 삭제합니다. 복원은 그때까지 하나의 POST입니다. 전체 설계는 [`docs/services-rfc.md`](../../docs/services-rfc.md)에 있습니다.

| 패키지 | 제공하는 것 |
|---|---|
| `@aipehub/services-sdk` | `ServicePlugin` 계약, 레지스트리, 로더. 플러그인 작성자가 구현하는 접점. |
| `@aipehub/service-memory-file` | 퍼스트파티 `memory:file` — 에피소딕 / 시맨틱 / 워킹을 JSONL로. |
| `@aipehub/service-artifact-file` | 퍼스트파티 `artifact:file` — MIME + 크기 가드가 있는 소유자당 파일 디렉토리. |
| `@aipehub/service-datastore-sqlite` | 퍼스트파티 `datastore:sqlite` — 선언된 이름당 하나의 `.sqlite`에서 KV + 원시 SQL. |

### 자체 플러그인 작성

```ts
// my-plugin/src/index.ts
import type { ServicePlugin } from '@aipehub/services-sdk'

class MyPlugin implements ServicePlugin {
  readonly type = 'memory'
  readonly impl = 'redis'
  readonly version = '0.1.0'

  async init(ctx) { /* redis 풀 열기 */ }
  async validateConfig(raw) { /* 잘못된 형태 파싱 + 거부 */ }
  async attach(owner, config) { /* MemoryHandle 반환 */ }
  async detach(owner) { /* 소유자당 캐시 닫기 */ }
  async softDelete(owner) { /* TrashRef 반환; 호스트가 저장 */ }
  async restore(ref) { /* 충돌 시 TrashRestoreConflictError 발생 */ }
  async hardDelete(ref) { /* 비가역적 */ }
  async describe(owner) { /* 관리자 UI 스냅샷 — sizeBytes, preview */ }
  async shutdown() { /* 드레인 + 닫기 */ }
}

export default () => new MyPlugin()
```

패키지 이름을 `<space>/services/plugins.json`에 드롭하고 호스트를 재시작하면 — `loadPlugins`가 항목을 동적 임포트하고, `init`을 호출하고, 플러그인이 모든 에이전트의 yaml `uses:`에서 사용 가능해집니다. 플러그인 로드 실패는 치명적이지 않습니다: 나쁜 플러그인은 부트 로그에 나타나지만 호스트를 충돌시키지 않습니다.

> **배포 참고사항**: 호스트는 자체 `node_modules/`에서 플러그인 패키지를 해결하므로, 서드파티 플러그인은 호스트가 볼 수 있는 곳에 설치되어야 합니다 — 호스트 워크스페이스에서 `pnpm add my-org/aipehub-redis-memory`, 또는 배포 이미지에 `package.json` 의존성으로. `plugins.json`에 패키지 이름을 넣는 것만으로는 패키지 자체가 디스크에 없으면 충분하지 않습니다.

## 패키지

| 패키지 | 목적 |
|---|---|
| `@aipehub/core` | 허브, 레지스트리, 스케줄러, 트랜스크립트, 스토리지, Participant 기본 클래스 |
| `@aipehub/web` | 임베드 가능한 참조 UI(HTTP + SSE + 바닐라 SPA) |
| `@aipehub/host` | 프로덕션 바이너리 — env 구동, 데모 상태 없음, `aipehub-host` 제공 |
| `@aipehub/protocol` | 와이어 프로토콜 타입 + 코덱(제로 런타임) |
| `@aipehub/transport-ws` | 허브 측 WebSocket 전송 |
| `@aipehub/sdk-node` | 원격 에이전트용 Node SDK(`TeamBridgeAgent`도 내보냄) |
| `@aipehub/llm` | `LlmAgent` 기본 클래스 + `LlmProvider` 인터페이스 + `MockLlmProvider` |
| `@aipehub/llm-anthropic` | Anthropic Claude 제공자(peer dep: `@anthropic-ai/sdk`) |
| `@aipehub/llm-openai` | OpenAI 제공자(peer dep: `openai`) |
| `@aipehub/services-sdk` | 허브 서비스 플러그인 계약(v2.2) — 위 섹션 참조 |
| `@aipehub/service-memory-file` | 퍼스트파티 `memory:file` 플러그인(디스크의 JSONL) |
| `@aipehub/service-artifact-file` | 퍼스트파티 `artifact:file` 플러그인(소유자당 디렉토리, MIME 게이트) |
| `@aipehub/service-datastore-sqlite` | 퍼스트파티 `datastore:sqlite` 플러그인(KV + SQL) |
| `@aipehub/mcp-server` | MCP(Model Context Protocol) 브리지 — Claude Desktop / Cursor가 허브를 구동하게 함 |
| `aipehub` (PyPI, `python-sdk/`에서) | Python SDK — 동일한 와이어 프로토콜을 통해 Python 에이전트를 허브에 연결 |

## 라이선스

프로젝트 자체에 대해 **MIT** — [`LICENSE`](../../LICENSE) 참조.

- ✅ 상업적 사용, 폐쇄 소스 파생물, 내부 SaaS 임베딩 — 모두 허용됩니다.
- ⚠️ 배포 시 LICENSE 파일 + 저작권 공지를 유지하세요.
- [`templates/community/`](../../templates/community/)의 서드파티 프롬프트 템플릿은 각자의 (호환) 라이선스를 가집니다 — CC0 1.0 및 MIT — [`templates/community/LICENSE-NOTICES.md`](../../templates/community/LICENSE-NOTICES.md)에 그대로 집계되어 있습니다.

일반적인 질문("폐쇄 소스에 임베드할 수 있나", "커뮤니티 템플릿에 귀속을 달아야 하나", "포크 + 이름 변경이 허용되나")은 [`docs/LICENSE-FAQ.md`](../../docs/LICENSE-FAQ.md)에서 답변됩니다.
