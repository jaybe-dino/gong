import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

// 테스트는 별도 DB 파일을 쓴다. 개발용 data/app.db 를 건드리지 않는다.
const TEST_DB = path.join(process.cwd(), "data", "test.db");
for (const s of ["", "-wal", "-shm"]) fs.rmSync(TEST_DB + s, { force: true });
process.env.GONG_DB = TEST_DB;
process.env.GONG_TODAY = "2026-09-01";

const { normHandle, cleanHandle, handleSimilarity, igUrl } = await import("../src/lib/handle.ts");
const { parseCsv, toObjects, parseFollowers, parseRelativeTime } = await import("../src/lib/csv.ts");
const { dealStatus, dday } = await import("../src/lib/deals.ts");
const { diffDays, addDays, dayLabel } = await import("../src/lib/clock.ts");

test("핸들 정규화 — 구두점과 대소문자를 지운다", () => {
  assert.equal(normHandle("@Sooyeon.Living"), "sooyeonliving");
  assert.equal(normHandle("sooyeon_living"), "sooyeonliving");
  assert.equal(normHandle("https://www.instagram.com/mom_dailylog/"), "momdailylog");
  assert.equal(normHandle("  @haru.trip?utm=1 "), "harutrip");
  assert.equal(normHandle(""), "");
});

test("표시용 핸들은 원 표기를 보존한다", () => {
  assert.equal(cleanHandle("@sooyeon.living"), "sooyeon.living");
  assert.equal(igUrl("@sooyeon.living"), "https://www.instagram.com/sooyeon.living");
});

test("핸들 유사도 — 구두점 차이만 있으면 동일로 본다", () => {
  assert.equal(handleSimilarity("livingnote_k", "livingnote.k"), 1);
  assert.ok(handleSimilarity("mom_dailylog", "momdailylog") === 1);
  assert.ok(handleSimilarity("haru.trip", "haru_trip_official") < 0.95);
  assert.ok(handleSimilarity("nara_home", "beauty_log") < 0.5);
});

test("CSV 파서 — 따옴표 안의 쉼표와 개행", () => {
  const rows = parseCsv('a,b\n"1,000","줄1\n줄2"\n');
  assert.deepEqual(rows, [
    ["a", "b"],
    ["1,000", "줄1\n줄2"],
  ]);
  const { headers, records } = toObjects(rows);
  assert.deepEqual(headers, ["a", "b"]);
  assert.equal(records[0].a, "1,000");
});

test("CSV 파서 — 이스케이프된 따옴표와 BOM", () => {
  const rows = parseCsv('﻿name\n"그는 ""안녕"" 이라 했다"');
  assert.equal(rows[0][0], "name");
  assert.equal(rows[1][0], '그는 "안녕" 이라 했다');
});

test("팔로워 파싱 — 만 단위와 반올림 오차", () => {
  assert.deepEqual(parseFollowers("10.8만"), { value: 108000, precision: 500 });
  assert.deepEqual(parseFollowers("11만"), { value: 110000, precision: 5000 });
  assert.deepEqual(parseFollowers("1,204"), { value: 1204, precision: 0 });
  assert.deepEqual(parseFollowers(""), { value: null, precision: 0 });
  assert.equal(parseFollowers("62K").value, 62000);
});

test("상대시간 파싱", () => {
  const now = new Date("2026-09-01T12:00:00Z");
  assert.equal(parseRelativeTime("약 1시간 전", now), "2026-09-01 11:00:00");
  assert.equal(parseRelativeTime("3일 전", now), "2026-08-29 12:00:00");
  assert.equal(parseRelativeTime("알 수 없음", now), null);
});

test("딜 상태 — 상시 공구는 D-DAY 집계에서 분리된다", () => {
  const timed = { starts_on: "2026-09-05", ends_on: "2026-09-10", is_always_on: 0 };
  assert.equal(dealStatus(timed, "2026-09-01"), "soon");
  assert.equal(dealStatus(timed, "2026-09-07"), "live");
  assert.equal(dealStatus(timed, "2026-09-11"), "past");

  const always = { starts_on: null, ends_on: null, is_always_on: 1 };
  assert.equal(dealStatus(always, "2026-09-01"), "always");
  assert.equal(dday(always, "2026-09-01").label, "상시");
});

test("D-DAY — 마감 당일은 '오늘 마감'", () => {
  const d = { starts_on: "2026-09-01", ends_on: "2026-09-07", is_always_on: 0 };
  assert.equal(dday(d, "2026-09-07").label, "오늘 마감");
  assert.equal(dday(d, "2026-09-07").kind, "k-stop");
  assert.equal(dday(d, "2026-09-04").label, "D-3");
  assert.equal(dday({ ...d, starts_on: "2026-09-05" }, "2026-09-01").label, "D-4");
});

test("날짜 헬퍼", () => {
  assert.equal(diffDays("2026-09-01", "2026-08-25"), 7);
  assert.equal(addDays("2026-08-31", 1), "2026-09-01");
  assert.equal(dayLabel("2026-09-01"), "09-01 (화)");
});
