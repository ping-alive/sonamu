import { randomBytes, randomUUID } from "node:crypto";
import { hostname } from "node:os";

// 세션 ID는 `${nodeId}:${uuid}` 형식이다. uuid에는 ':'가 없으므로 마지막 ':'로 나누면
// 노드 ID에 ':' 같은 구분자가 들어 있어도 그대로 복원된다
const SESSION_ID_SEPARATOR = ":";
const SESSION_SUFFIX_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * 기본 노드 ID를 만든다. 형식은 `${hostname()}-${process.pid}-${짧은 랜덤}`이다.
 * 컨테이너 재시작 뒤 hostname과 pid가 같아도 이전 노드의 stale 상태를 물려받지 않도록 랜덤 접미사를 붙인다.
 */
export function createWebSocketNodeId(): string {
  return `${hostname()}-${process.pid}-${randomBytes(6).toString("base64url")}`;
}

/**
 * 노드 ID를 포함한 세션 ID를 만든다. `connections` audience는 이 ID만으로 대상 노드를 찾으므로 store 조회가 필요 없다.
 */
export function createWebSocketSessionId(nodeId: string): string {
  return `${nodeId}${SESSION_ID_SEPARATOR}${randomUUID()}`;
}

/**
 * 세션 ID에서 노드 ID를 복원한다. Sonamu가 만든 형식이 아니면 undefined를 반환한다.
 */
export function parseWebSocketSessionNodeId(sessionId: string): string | undefined {
  const separatorIndex = sessionId.lastIndexOf(SESSION_ID_SEPARATOR);
  if (separatorIndex < 0) {
    return undefined;
  }

  const suffix = sessionId.slice(separatorIndex + SESSION_ID_SEPARATOR.length);
  if (!SESSION_SUFFIX_PATTERN.test(suffix)) {
    return undefined;
  }

  return sessionId.slice(0, separatorIndex);
}
