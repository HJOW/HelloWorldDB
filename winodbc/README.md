# HelloWorldDB Windows ODBC

Windows 네이티브 ODBC 3.8 드라이버 프로젝트이다. 현재 **WO-0(목표·지원 계약·개발 환경 확인) 완료** 상태이며, 아직 드라이버 DLL이나 접속 기능은 없다. 다음 구현은 [WO-1](PROGRESS.md)의 x86/x64 DLL·시험 앱 기반이다.

- [개발 환경과 목표 앱](docs/environment.md)
- [API·속성·descriptor·길이 단위 지원 계획](docs/api-support.md)
- [타입 대응](docs/type-mapping.md)
- [서버 기능 협상과 진단 매핑](docs/server-dependencies.md)
- [의존성과 배포 정책](docs/dependencies.md)
- [검증 기록과 시험 ID](docs/verification.md)

저장소 루트에서 다음 명령으로 환경을 다시 조회하고 WO-0 문서 계약을 검사한다. Node.js는 개발용 검사에만 사용하며 제품 실행 의존성이 아니다.

```powershell
powershell -NoProfile -File winodbc/scripts/inspect-environment.ps1
node --test winodbc/tests/wo0.test.mjs
```

조회 결과는 `winodbc/build/wo0/environment.json`에 기록한다. 생성 파일·시험 자료·추후 임시 서버의 config/data/log와 빌드/배포물도 모두 `winodbc` 안에 둔다. 기존 프로젝트는 읽기 참조만 한다. 이번 작업의 진행 요약도 [PROGRESS.md](PROGRESS.md)에 모았다.
