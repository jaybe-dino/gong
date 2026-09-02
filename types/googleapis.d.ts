/**
 * googleapis 는 선택 의존성이다. 설치돼 있지 않아도 빌드가 되어야 하므로
 * 최소한의 형태만 선언해 둔다. 실제 호출은 gmail.ts 가 try/catch 로 감싼다.
 * (설치하면 진짜 타입이 이 선언을 대체한다)
 */
declare module "googleapis" {
  export const google: {
    auth: {
      OAuth2: new (clientId?: string, clientSecret?: string, redirectUri?: string) => {
        setCredentials(credentials: Record<string, unknown>): void;
      };
    };
    gmail(options: { version: string; auth: unknown }): unknown;
  };
}
