import { type z } from "zod";

export type WebSocketUserId = number | string;
export type WebSocketRoomId = string;
export type MaybePromise<T> = T | Promise<T>;

export interface ManagedWebSocketConnection {
  id: string;
  namespace: string;
  closed: boolean;
  // setUserId/clearUserId 호출로 갱신됨. telemetry emit 사이트에서 hot path lookup을 피하기 위해 connection에 캐싱한다
  readonly userId?: string;
  publishUntyped<Data>(event: string, data: Data): void;
  close(code?: number, reason?: string): void;
}

/**
 * registry가 소유하는 로컬 연결. 인코딩된 frame을 그대로 보내는 경로와 route 식별자를 가진다.
 */
export interface WebSocketFrameConnection extends ManagedWebSocketConnection {
  // route table의 키. 원격 노드가 보낸 envelope에서 이 연결이 받을 frame을 고를 때 쓴다
  readonly routeKey?: string;
  // route table에 없는 연결이 로컬 publish를 받을 때 쓰는 자기 스키마
  readonly outEvents: z.ZodObject;
  sendFrame(event: string, frame: string): void;
}

export type WebSocketRegistryStats = {
  totalConnections: number;
  totalRooms: number;
  byNamespace: Record<string, number>;
};
