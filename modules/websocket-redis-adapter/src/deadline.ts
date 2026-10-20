export class RedisWebSocketDeadlineError extends Error {
  override readonly name = "RedisWebSocketDeadlineError";

  constructor(deadlineMs: number) {
    super(`Redis 호출이 ${deadlineMs}ms deadline 안에 끝나지 않았습니다.`);
  }
}

export type DeadlineToken = {
  readonly expired: boolean;
};

/**
 * 작업을 deadline으로 감싼다. node-redis의 timeout은 이미 전송된 명령을 끝내지 못하므로 어댑터가 직접 상한을 둔다.
 * deadline 뒤에 도착한 결과는 무시하고, 늦은 rejection은 삼켜 unhandledRejection이 생기지 않게 한다.
 * 작업은 token.expired로 deadline 경과를 확인해 재시도 같은 후속 명령을 보내지 않을 수 있다.
 */
export function withDeadline<T>(
  operation: (token: DeadlineToken) => Promise<T>,
  deadlineMs: number,
): Promise<T> {
  const token = { expired: false };
  const work = Promise.resolve().then(() => operation(token));
  work.catch(() => {});

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      token.expired = true;
      reject(new RedisWebSocketDeadlineError(deadlineMs));
    }, deadlineMs);
  });

  return Promise.race([work, deadline]).finally(() => {
    clearTimeout(timer);
  });
}
