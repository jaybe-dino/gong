-- 014: 하드 실링을 워밍업 곡선 꼭대기에 맞춘다
--
-- daily_cap 의 스키마 기본값은 75 다. 워밍업 곡선이 이메일 250 · DM 80 까지
-- 올라가도록 넓히고 나니, 기존 행의 75 가 곡선을 눌러 "계정 400일인데 권장
-- 75건" 이 되었다. 화면에는 "(하드 실링 75건이 더 낮음)" 이라고 나오지만,
-- 왜 안 오르는지 알려면 그 괄호를 읽어야 한다.
--
-- 75 는 운영자가 고른 값이 아니라 스키마 기본값이다. 곡선 꼭대기로 올린다.
-- 낮추고 싶으면 설정 화면에서 언제든 내릴 수 있고, 권장 상한은 기본적으로
-- 발송을 막지 않으므로 이 변경이 더 보내게 만들지는 않는다 — 표시되는 권장
-- 숫자만 곡선을 따라간다.

UPDATE sender SET daily_cap = 250 WHERE channel = 'email'        AND daily_cap < 250;
UPDATE sender SET daily_cap =  80 WHERE channel = 'instagram_dm' AND daily_cap <  80;

-- 그 외 채널(사람이 손으로 하는 큐)은 MANUAL_RULE 의 꼭대기에 맞춘다.
UPDATE sender SET daily_cap = 200
 WHERE channel NOT IN ('email', 'instagram_dm') AND daily_cap < 200;
