import Link from "next/link";
import Shell from "@/components/Shell";
import { Card, Empty, Note, Pill, Scroller } from "@/components/ui";
import { fmt } from "@/lib/format";
import { hasTable, schemaState } from "@/lib/schema";
import * as B from "@/lib/blast";
import { create } from "./actions";

export const dynamic = "force-dynamic";

/**
 * 1단계 — 발송 방식 선택.
 *
 * 채널을 고르는 것이 첫 결정이다. 채널이 정해지면 닿을 수 있는 대상 모집단이
 * 정해지고(이메일 1,851 · 인링크 6,997 …), 자동 발송인지 작업 큐인지도 정해진다.
 * 그래서 카테고리·팔로워 필터보다 먼저 묻는다.
 */
export default async function BlastListPage({
  searchParams,
}: {
  searchParams: Promise<{ msg?: string; kind?: string }>;
}) {
  const sp = await searchParams;
  const ready = await hasTable("blast");
  const schema = await schemaState();

  const [blasts, reach] = await Promise.all([
    ready ? B.listBlasts() : Promise.resolve([]),
    ready
      ? Promise.all(B.CHANNELS.map(async (c) => [c.key, await B.countTargets(c.key, { cooldownDays: null })] as const))
      : Promise.resolve([] as (readonly [string, number])[]),
  ]);
  const reachMap = Object.fromEntries(reach);

  return (
    <Shell path="/blast" title="발송" sub="방식 선택 → 대상 정리 → 내용 작성 → 발송 → 결과">
      <section className="screen blast">
        {sp.msg && <Note tone={sp.kind === "err" ? "stop" : undefined}>{sp.msg}</Note>}

        {!ready && (
          <Note tone="stop">
            <b>마이그레이션 {schema.pending.length}개가 아직 적용되지 않았습니다.</b>{" "}
            <a href="/setup">초기 설정</a> 에서 <b>1. 스키마 적용</b> 을 누른 뒤 다시 오세요.
          </Note>
        )}

        <Card title="1 · 발송 방식 선택" hint="채널이 정해지면 닿을 수 있는 대상이 정해집니다">
          <div className="card-b">
            <form action={create}>
              <label className="field" style={{ maxWidth: 420, marginBottom: 14 }}>
                <span>발송 이름 (우리끼리 부르는 이름)</span>
                <input name="name" placeholder="9월 리빙 공구 1차" required maxLength={80} />
              </label>

              <div className="chcards">
                {B.CHANNELS.map((c) => (
                  <label className="chcard" key={c.key}>
                    <input type="radio" name="channel" value={c.key} defaultChecked={c.key === "email"} required />
                    <div>
                      <b>{c.label}</b>
                      {c.auto
                        ? <Pill tone="k-ok">자동 발송</Pill>
                        : <Pill tone="k-warn">작업 큐 · 사람이 붙여넣기</Pill>}
                      <p>{c.hint}</p>
                      <span className="mono">닿을 수 있는 대상 {fmt(reachMap[c.key] ?? 0)}명</span>
                    </div>
                  </label>
                ))}
              </div>

              <div className="foot">
                <button className="btn pri" type="submit" disabled={!ready}>다음 · 대상 정리 →</button>
                <span className="hint">
                  이메일만 자동으로 나갑니다. 인스타 DM 은 임의의 핸들에 첫 DM 을 보내는 API 가 없고,
                  인포크·인링크는 상대의 폼에 붙여넣는 방식입니다.
                </span>
              </div>
            </form>
          </div>
        </Card>

        <Card title="지난 발송" hint="중간에 나간 것도 여기서 이어서 할 수 있습니다">
          {blasts.length === 0 ? (
            <div className="card-b"><Empty>아직 발송이 없습니다. 위에서 하나 만드세요.</Empty></div>
          ) : (
            <Scroller wide>
              <table>
                <thead>
                  <tr><th>이름</th><th>방식</th><th>상태</th><th>대상</th><th>발송</th><th>회신</th><th>만든 날</th><th /></tr>
                </thead>
                <tbody>
                  {blasts.map((x) => (
                    <tr key={x.id}>
                      <td><b>{x.name}</b></td>
                      <td>{B.CHANNELS.find((c) => c.key === x.channel)?.label ?? x.channel}</td>
                      <td>
                        {x.state === "done" ? <Pill tone="k-ok">완료</Pill>
                          : x.state === "sending" ? <Pill tone="k-warn">발송 중</Pill>
                          : x.state === "targeted" ? <Pill tone="k-acc">대상 확정</Pill>
                          : <Pill tone="k-warn">작성 중</Pill>}
                      </td>
                      <td className="num">{fmt(x.target_count)}</td>
                      <td className="num">{fmt(x.sent)}</td>
                      <td className="num">{fmt(x.replied)}</td>
                      <td className="num">{x.created_at}</td>
                      <td>
                        <Link className="btn sm" href={`/blast/${x.id}?step=${
                          x.state === "done" ? 5 : x.state === "targeted" ? 3 : x.state === "sending" ? 4 : 2}`}>
                          {x.state === "done" ? "결과" : "이어서"}
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Scroller>
          )}
        </Card>

        <Card title="발송할 이메일 등록" hint="여기 등록된 주소로만 나갑니다">
          <div className="card-b">
            <p className="lede" style={{ margin: "0 0 12px" }}>
              발신 메일함은 설정에서 등록합니다. 등록·기본 지정·연결 점검·수신 테스트가 한 화면에 있습니다.
            </p>
            <a className="btn" href="/settings">계정 연동 · 설정 열기 →</a>
          </div>
        </Card>
      </section>
    </Shell>
  );
}
