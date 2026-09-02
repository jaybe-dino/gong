import Shell from "@/components/Shell";
import { Card, Note, Scroller } from "@/components/ui";
import { one } from "@/lib/db";

export const dynamic = "force-dynamic";

const SCREENS: [string, string, string][] = [
  ["대시보드", "오늘 처리할 큐, 파이프라인 퍼널, 발신 계정 건강도", "어디까지 진행됐는지 매번 사람에게 물어봐야 함"],
  ["공구 캘린더", "날짜별 진행·예정·마감 공구, 셀러 인스타 링크백", "지금 무엇이 열려 있는지 알 수 없음"],
  ["변화 감지", "스냅샷 간 델타 6종, 워치리스트 알림", "경쟁 브랜드 공구가 열린 걸 나중에 알게 됨"],
  ["인플루언서 DB", "통합 필터 · 적합도 정렬 · 상세 드로어", "엑셀 시트 여러 개를 눈으로 대조"],
  ["딜 · 브랜드 탐색", "브랜드별 공구 이력, 경쟁 브랜드 확인", "이미 경쟁사 공구를 돌린 셀러에게 제안"],
  ["데이터 임포트", "CSV → 컬럼 매핑 → 중복 미리보기 → 병합", "같은 사람이 3개 행으로 중복 등록"],
  ["캠페인", "타깃 추천, 스테이지 칸반, GMV 집계", "제안은 보냈는데 그 다음이 관리되지 않음"],
  ["제안 발송", "세그먼트 → 템플릿 → 정책 게이트 → 발송", "수신거부자에게 재발송, 광고 표기 누락"],
  ["작업 큐", "DM · 인포크 수동 발송 배급, 계정별 상한", "담당자가 감으로 보내다 계정 정지"],
  ["통합 인박스", "회사 메일 한 개의 스레드를 캠페인에 붙여 관리", "회신이 개인 메일함에 흩어짐"],
  ["채널 정책", "채널별 콜드 허용·야간 차단·쿨다운, 발신 계정 상한", "컴플라이언스가 사람의 기억에 의존"],
];

export default async function PlanPage() {
  const [creators, brands, deals, tables] = await Promise.all([
    one<{ n: string }>(`SELECT count(*) AS n FROM creator`),
    one<{ n: string }>(`SELECT count(*) AS n FROM brand`),
    one<{ n: string }>(`SELECT count(*) AS n FROM deal`),
    one<{ n: string }>(`SELECT count(*) AS n FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'`),
  ]);

  return (
    <Shell path="/plan" title="설계 개요" sub="메일링 · 데이터 유입 · 매칭">
      <section className="screen">
        <p className="lede">
          두 축 — <b>회사 이메일 한 개로 도는 발송·회신 커뮤니케이션</b>과{" "}
          <b>3개 소스를 합친 딜·브랜드 DB 위의 캠페인 추천</b> — 의 동작 방식입니다. 나머지 화면은 이 설계를 그대로
          구현한 것이고, 화면에 보이는 수치는 전부 로컬 SQLite 에서 계산됩니다.
        </p>

        <div className="arch">
          <div className="abox">
            <span className="kick">A · 메일링</span>
            <h4>주소는 하나, 스레드는 자동으로 매핑</h4>
            <p>
              발송·수신 모두 <code className="mono">partner@dinostudio.kr</code> 한 개로 통일합니다. 담당자별 주소를
              만들지 않습니다.
            </p>
            <ul>
              <li>Gmail API OAuth 연동 (자체 SMTP 미사용)</li>
              <li>
                발신 표시는 <code className="mono">담당자명 &lt;partner@…&gt;</code>
              </li>
              <li>
                Reply-To 에 <code className="mono">partner+cm_&#123;token&#125;@</code> 플러스 주소 → 회신이 어느
                캠페인·어느 크리에이터인지 <b>자동 매핑</b>
              </li>
              <li>
                Gmail <code className="mono">threadId</code> = 우리 <code className="mono">thread.thread_key</code>. 회신은
                항상 같은 스레드에 꽂힙니다
              </li>
              <li>
                watch API 푸시 → 수신 즉시 <code className="mono">message(direction=&apos;in&apos;)</code> 생성 + 시퀀스
                자동 중단
              </li>
            </ul>
          </div>
          <div className="abox">
            <span className="kick">B · 데이터 유입</span>
            <h4>업로드 → 정규화 → 병합, 원문은 저장하지 않음</h4>
            <p>
              세 소스 모두 약관에서 자동 수집을 금지합니다. CSV 업로드 경로만 만들고, 저장하는 것은{" "}
              <b>파생 지표와 링크백</b>입니다.
            </p>
            <ul>
              <li>
                공통 자연키는 <b>인스타 핸들</b> 하나뿐 → <code className="mono">handle_norm</code> 으로 정규화 후 매칭
              </li>
              <li>
                맘캘 슬러그 <code className="mono">de-elisa-shop</code> 은 <code className="mono">.</code>/
                <code className="mono">_</code> 구분 불가 → 슬러그를 키로 쓰지 않음 (임포터가 후보에서 제외)
              </li>
              <li>
                소스별 원 PK 는 <code className="mono">source_ref</code> 에 보존 (역추적용)
              </li>
              <li>덮어쓰지 않고 <code className="mono">account_snapshot</code> 을 쌓아 델타를 뽑음</li>
            </ul>
          </div>
          <div className="abox">
            <span className="kick">C · 매칭</span>
            <h4>&quot;누구에게&quot; 가 아니라 &quot;언제 누구에게&quot;</h4>
            <p>딜 이력이 쌓이면 타깃 추천이 리스트 필터가 아니라 타이밍 추천이 됩니다.</p>
            <ul>
              <li>
                <b>공구 실적 40</b> — 최근 30일 건수. 마지막 공구 120일 초과면 50% 감쇠
              </li>
              <li>
                <b>참여 품질 25</b> — ER 백분위 × credibility. 진성 50% 미만이면 0
              </li>
              <li>
                <b>카테고리 20 · 도달 15</b> — 팔로워는 점수 축이 아니라 분류 축입니다
              </li>
              <li>
                <b>브랜드 충돌</b> — 30일 이내 제외 / 60일 −15 / 90일 −5, 진행·예정 3건 이상 −8
              </li>
            </ul>
          </div>
        </div>

        <Note tone="warn">
          <b>확인 필요.</b> insta-gong 웹에서는 인플루언서 <b>510명</b>만 노출되고 <code className="mono">/brands</code>
          는 404입니다. &quot;딜 34,650건 / 브랜드 8,150개&quot;는 웹에서 재현되지 않아, 앱 화면이나 로그인 뷰의
          수치인지 확인이 필요합니다. 현재 DB 는 세 소스 합집합 추정치로 채워져 있습니다 — 크리에이터 <b>{Number(creators?.n).toLocaleString("ko-KR")}명</b>, 브랜드 <b>{brands?.n}개</b>, 딜{" "}<b>{Number(deals?.n).toLocaleString("ko-KR")}건</b>.
        </Note>

        <Card title="화면 구성" hint="왼쪽 메뉴에서 바로 이동할 수 있습니다">
          <Scroller wide>
            <table>
              <thead>
                <tr>
                  <th>화면</th>
                  <th>핵심 동작</th>
                  <th>이 화면이 없으면 생기는 일</th>
                </tr>
              </thead>
              <tbody>
                {SCREENS.map(([a, b, c]) => (
                  <tr key={a}>
                    <td>
                      <b>{a}</b>
                    </td>
                    <td>{b}</td>
                    <td>{c}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Scroller>
        </Card>

        <Card title="기술 구성" hint="이 저장소가 실제로 돌리는 것">
          <div className="card-b">
            <ul className="tight">
              <li>
                <b>Next.js App Router (서버 컴포넌트)</b> — 화면은 서버에서 SQL 을 실행해 렌더합니다. 클라이언트로
                내려가는 데이터는 화면에 그려지는 것뿐입니다.
              </li>
              <li>
                <b>PostgreSQL</b> — <code className="mono">db/001_schema.sql</code> 한 파일에 스키마
                {" "}{tables?.n}개 테이블이 다 들어 있습니다. <code className="mono">npm run db:reset</code> 으로 재생성합니다.
              </li>
              <li>
                <b>적합도 · 정책 엔진</b> — <code className="mono">src/lib/score.ts</code>,{" "}
                <code className="mono">src/lib/policy-gate.ts</code>, <code className="mono">src/lib/states.ts</code>.
                화면이 아니라 이 세 파일이 판정합니다.
              </li>
              <li>
                <b>임포터</b> — <code className="mono">src/lib/importer.ts</code>. 실제 CSV 를 올리면 파싱·매핑 추론·중복
                검사까지 돌아갑니다.
              </li>
            </ul>
          </div>
        </Card>
      </section>
    </Shell>
  );
}
