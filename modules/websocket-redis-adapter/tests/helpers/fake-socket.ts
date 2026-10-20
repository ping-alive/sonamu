import { EventEmitter } from "node:events";

import { type WebSocketTransport } from "sonamu";

/**
 * ws 패키지의 WebSocket을 흉내내는 테스트용 소켓.
 * sonamu 코어 테스트(ws-test-helpers.ts)의 FakeWebSocket과 같은 형태를 유지한다.
 */
export class FakeWebSocket extends EventEmitter {
  readyState: 0 | 1 | 2 | 3 = 1;
  bufferedAmount = 0;
  sentMessages: string[] = [];
  pingCount = 0;
  closedWith: { code?: number; reason?: string } | null = null;

  send(data: string): void {
    this.sentMessages.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closedWith = { code, reason };
    this.readyState = 3;
    this.emit("close", code ?? 1000, Buffer.from(reason ?? "", "utf-8"));
  }

  ping(): void {
    this.pingCount += 1;
  }

  terminate(): void {
    this.readyState = 3;
    this.emit("close", 1006, Buffer.alloc(0));
  }

  // 클라이언트 쪽에서 연결이 끊긴 상황을 흉내낸다
  simulateRemoteClose(): void {
    this.readyState = 3;
    this.emit("close", 1001, Buffer.from("client gone", "utf-8"));
  }
}

export function asWebSocket(socket: FakeWebSocket): WebSocketTransport {
  return {
    get bufferedAmount() {
      return socket.bufferedAmount;
    },
    get readyState() {
      return socket.readyState;
    },
    close(code, reason) {
      socket.close(code, reason?.toString());
    },
    off(...args) {
      socket.off(...args);
    },
    on(...args) {
      socket.on(...args);
    },
    ping() {
      socket.ping();
    },
    send(data) {
      socket.send(data.toString());
    },
    terminate() {
      socket.terminate();
    },
  };
}

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };
export type ReceivedFrame = { event: string; data: { [key: string]: JsonValue } };

// 테스트에서 받은 frame을 파싱한다. 깨진 JSON이면 원문을 포함해 실패시킨다
export function parseFrame(raw: string): ReceivedFrame {
  try {
    return /* SAFETY: runtime이 직렬화한 frame만 넘긴다. */ JSON.parse(raw) as ReceivedFrame;
  } catch (error) {
    throw new Error(`frame JSON 파싱 실패: ${raw}`, { cause: error });
  }
}

export function framesOf(socket: FakeWebSocket): ReceivedFrame[] {
  return socket.sentMessages.map(parseFrame);
}
