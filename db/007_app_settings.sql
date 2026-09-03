-- 007: 설정을 DB 에서 관리 + Google OAuth 토큰 보관
--
-- 발신 주소·조직명·사업장 주소 같은 값을 환경 변수로만 두면 바꿀 때마다 재배포해야
-- 한다. 법정 표기(주소·전화)는 오타 하나로 발송이 막히는 값이라 화면에서 고칠 수
-- 있어야 한다.
--
-- 우선순위: DB 설정 > 환경 변수 > 기본값. 기존 배포가 환경 변수만으로도 그대로 돌게 한다.

CREATE TABLE IF NOT EXISTS app_setting (
  key         text PRIMARY KEY,
  value       text,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  uuid REFERENCES app_user(id)
);

/*
 * Google OAuth 자격 증명.
 *
 * refresh_token 은 이 계정으로 메일을 보낼 수 있는 열쇠다. 화면에 절대 내보내지
 * 않는다 — 연결 여부와 계정 주소만 보여준다. 조회 함수도 토큰을 반환하지 않게
 * 나눠 두었다(loadToken 은 서버 어댑터만 쓴다).
 *
 * sender 와 1:1 이다. 발신 계정마다 별도 인증이 필요하다.
 */
CREATE TABLE IF NOT EXISTS oauth_credential (
  sender_id     uuid PRIMARY KEY REFERENCES sender(id) ON DELETE CASCADE,
  provider      text NOT NULL DEFAULT 'google',
  account_email text,
  refresh_token text NOT NULL,
  scopes        text[] NOT NULL DEFAULT '{}',
  obtained_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz,
  last_error    text
);

-- OAuth 왕복의 state. CSRF 방어 — 콜백이 우리가 시작한 요청인지 확인한다.
CREATE TABLE IF NOT EXISTS oauth_state (
  state      text PRIMARY KEY,
  sender_id  uuid REFERENCES sender(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 발송/수신 테스트 기록. "보냈는데 안 왔다" 를 눈으로 확인할 수 있어야 한다.
CREATE TABLE IF NOT EXISTS mail_test (
  id           bigserial PRIMARY KEY,
  sender_id    uuid REFERENCES sender(id) ON DELETE SET NULL,
  kind         text NOT NULL,              -- send | receive | dns
  target       text,
  ok           boolean NOT NULL,
  detail       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS mail_test_recent ON mail_test (created_at DESC);
