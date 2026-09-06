import { createCampaign, updateCampaign } from "./actions";
import { CATEGORIES, STATUS_LABEL } from "./fields";
import type { CampaignRow } from "@/lib/queries";

/**
 * 캠페인 생성·수정 폼.
 *
 * details/summary 로 접는다 — 클라이언트 컴포넌트를 하나 더 만들 이유가 없다.
 * 캠페인이 하나도 없을 때는 펼친 채로 연다. 빈 화면에서 "어디를 눌러야 하지" 를
 * 겪게 하지 않는다.
 *
 * 검사에 걸려 되돌아온 값(prefill)은 저장된 값보다 우선한다. 실패했다고 입력을
 * 비우면 일곱 칸을 다시 친다 — 서버까지 도달하는 오류는 날짜 순서·수수료 범위처럼
 * 브라우저가 못 잡는 것들이라, 되돌려주지 않으면 매번 전부 다시 쓰게 된다.
 */
export default function CampaignForm({
  campaign,
  open,
  prefill,
}: {
  campaign: CampaignRow | null;
  open: boolean;
  prefill?: Record<string, string>;
}) {
  const editing = Boolean(campaign);
  const v = campaign;
  const pre = (key: string, saved: string | number | null | undefined) =>
    prefill?.[key] ?? (saved == null ? "" : String(saved));

  return (
    <details className="cform" open={open}>
      <summary>{editing ? `${v!.name} 수정` : "+ 새 캠페인"}</summary>
      <form action={editing ? updateCampaign : createCampaign}>
        {editing && <input type="hidden" name="id" value={v!.id} />}

        <div className="grid">
          <label className="field wide">
            <span>캠페인 이름 *</span>
            <input name="name" defaultValue={pre("name", v?.name)} required maxLength={80}
                   placeholder="9월 리빙 공구" />
          </label>

          <label className="field">
            <span>브랜드명 *</span>
            <input name="brand_name" defaultValue={pre("brand_name", v?.brand_name)} required
                   placeholder="락앤락" />
          </label>

          <label className="field">
            <span>카테고리 *</span>
            <select name="category" defaultValue={pre("category", v?.category) || CATEGORIES[0]} required>
              {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </label>

          <label className="field">
            <span>수수료율 (%)</span>
            <input name="commission_rate" type="number" min="0" max="100" step="0.5"
                   defaultValue={pre("commission_rate", v?.commission_rate)} placeholder="15" />
          </label>

          <label className="field">
            <span>목표 인원</span>
            <input name="target_count" type="number" min="1" step="1"
                   defaultValue={pre("target_count", null)} placeholder="50" />
          </label>

          <label className="field">
            <span>판매 시작</span>
            <input name="sale_from" type="date" defaultValue={pre("sale_from", v?.sale_from)} />
          </label>

          <label className="field">
            <span>판매 종료</span>
            <input name="sale_to" type="date" defaultValue={pre("sale_to", v?.sale_to)} />
          </label>

          <label className="field wide">
            <span>상태</span>
            <select name="status" defaultValue={pre("status", v?.status) || "running"}>
              {Object.entries(STATUS_LABEL).map(([k, label]) => (
                <option key={k} value={k}>{label}</option>
              ))}
            </select>
          </label>
        </div>

        <div className="foot">
          <button className="btn pri" type="submit">{editing ? "저장" : "캠페인 만들기"}</button>
          {editing && <a className="btn" href={`/campaigns?id=${v!.id}`}>취소</a>}
          <span className="hint">
            카테고리는 적합도 20점을 좌우합니다 — 실제 판매 품목에 가장 가까운 것을 고르세요.
          </span>
        </div>
      </form>
    </details>
  );
}
