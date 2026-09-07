import Shell from "@/components/Shell";
import { Card, Note } from "@/components/ui";
import { CATEGORY_KEYS } from "@/lib/score";
import { TIERS } from "@/lib/blast";
import { SOURCE_TYPES } from "@/lib/manual-creator";
import { addCreator } from "./actions";

export const dynamic = "force-dynamic";

/**
 * 인플루언서 직접 등록.
 *
 * CSV 임포트는 수천 건을 한 번에 넣는 경로다. 미팅에서 명함을 받거나 인바운드
 * 문의가 오면 그 자리에서 한 명을 넣어야 하는데, 그러려고 CSV 를 만들 사람은 없다.
 *
 * 필수는 두 개뿐이다 — 인스타 핸들과 연락처 수집 출처. 나머지는 나중에 채워도
 * 되지만 출처는 소급이 불가능하다.
 */
export default async function NewCreatorPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const sp = await searchParams;
  const ok = sp.kind === "ok";
  // 실패로 되돌아온 값. 성공했으면 비운다 — 연달아 여러 명 넣는 화면이다.
  const f = ok ? {} : Object.fromEntries(
    Object.entries(sp).filter(([k, v]) => k.startsWith("f_") && v).map(([k, v]) => [k.slice(2), v as string]),
  );

  return (
    <Shell path="/influencers" title="인플루언서 직접 등록" sub="한 명씩 · 명함 · 인바운드 문의">
      <section className="screen blast">
        {sp.msg && (
          <Note tone={sp.kind === "err" ? "stop" : undefined}>
            {sp.msg}
            {sp.dup && <> <a href={`/influencers?q=${encodeURIComponent(f.handle ?? "")}`}>기존 항목 보기 →</a></>}
          </Note>
        )}

        <form action={addCreator}>
          <Card title="계정" hint="인스타 핸들만 필수입니다">
            <div className="card-b">
              <div className="grid">
                <label className="field">
                  <span>인스타 핸들 *</span>
                  <input name="handle" required defaultValue={f.handle ?? ""}
                         placeholder="@sooyeon.living 또는 주소 전체" />
                  <small style={{ color: "var(--ink-3)", fontSize: 11 }}>
                    @ 나 instagram.com/ 을 붙여 넣어도 알아서 떼어냅니다.
                  </small>
                </label>

                <label className="field">
                  <span>표시 이름</span>
                  <input name="displayName" defaultValue={f.displayName ?? ""}
                         placeholder="비우면 핸들을 씁니다" />
                </label>

                <label className="field">
                  <span>팔로워</span>
                  <input name="followers" defaultValue={f.followers ?? ""} placeholder="5.4만 · 54000" />
                </label>

                <label className="field">
                  <span>카테고리</span>
                  <select name="category" defaultValue={f.category ?? ""}>
                    <option value="">— 없음 —</option>
                    {CATEGORY_KEYS.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                  <small style={{ color: "var(--ink-3)", fontSize: 11 }}>
                    적합도 20점이 이 값으로 매겨집니다.
                  </small>
                </label>

                <label className="field">
                  <span>티어</span>
                  <select name="tier" defaultValue={f.tier ?? ""}>
                    <option value="">— 없음 —</option>
                    {TIERS.map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                </label>

                <label className="field">
                  <span>DM 딥링크</span>
                  <input name="dmUrl" defaultValue={f.dmUrl ?? ""} placeholder="https://ig.me/m/handle" />
                </label>

                <label className="chk wide">
                  <input type="checkbox" name="hasGonggu" value="1" defaultChecked={Boolean(f.hasGonggu)} />
                  <span>공구 이력 징후가 있음</span>
                </label>
              </div>
            </div>
          </Card>

          <Card title="연락처" hint="있는 것만 채우세요. 하나도 없으면 DM 만 가능합니다">
            <div className="card-b">
              <div className="grid">
                <label className="field">
                  <span>이메일</span>
                  <input name="email" type="email" defaultValue={f.email ?? ""} placeholder="name@example.com" />
                </label>
                <label className="field">
                  <span>전화</span>
                  <input name="phone" defaultValue={f.phone ?? ""} placeholder="010-1234-5678" />
                </label>
                <label className="field">
                  <span>카카오</span>
                  <input name="kakao" defaultValue={f.kakao ?? ""} placeholder="채널 주소 또는 ID" />
                </label>
                <label className="field">
                  <span>인링크 폼</span>
                  <input name="inlinkUrl" defaultValue={f.inlinkUrl ?? ""} placeholder="https://inlink.to/…" />
                </label>
                <label className="field wide">
                  <span>링크인바이오 (인포크 · 리틀리 등)</span>
                  <input name="linkInBio" defaultValue={f.linkInBio ?? ""} placeholder="https://link.inpock.co.kr/…" />
                  <small style={{ color: "var(--ink-3)", fontSize: 11 }}>
                    주소를 보고 인포크·인링크·리틀리 중 어느 채널인지 자동으로 가릅니다.
                  </small>
                </label>
              </div>
            </div>
          </Card>

          <Card title="수집 출처" hint="법으로 필수입니다 — 소급이 불가능한 유일한 값입니다">
            <div className="card-b">
              <div className="grid">
                <label className="field">
                  <span>어디서 얻었는가 *</span>
                  <select name="sourceType" required defaultValue={f.sourceType ?? "bio_public"}>
                    {SOURCE_TYPES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
                  </select>
                </label>
                <label className="field">
                  <span>원본 주소</span>
                  <input name="sourceUrl" defaultValue={f.sourceUrl ?? ""}
                         placeholder="비우면 인스타 프로필 주소로 기록" />
                </label>
                <label className="field wide">
                  <span>메모</span>
                  <input name="note" defaultValue={f.note ?? ""}
                         placeholder="예: 9/5 리빙 박람회에서 명함 받음" />
                </label>
              </div>

              <Note>
                <code className="mono">contact_point.source_type · source_url · collected_by</code> 는 NOT NULL
                입니다. 크리에이터가 &quot;내 연락처를 어디서 얻었냐&quot;고 물으면 즉시 답할 수 있어야 합니다
                (개인정보보호법 §20). 출처를 진술할 수 없는 연락처는 <b>저장 자체가 되지 않습니다</b>.
              </Note>

              <div className="foot">
                <button className="btn pri" type="submit">등록</button>
                <a className="btn" href="/influencers">인플루언서 DB 로</a>
                <span className="hint">
                  이미 있는 핸들이면 새로 만들지 않고 알려드립니다 — 같은 사람을 두 번 넣으면 두 번 보냅니다.
                </span>
              </div>
            </div>
          </Card>
        </form>
      </section>
    </Shell>
  );
}
