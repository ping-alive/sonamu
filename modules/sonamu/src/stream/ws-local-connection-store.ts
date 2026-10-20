import { isFunctionValue } from "../utils/runtime-value";
import { type WebSocketFrameConnection } from "./ws-core";
import {
  type WebSocketTelemetryConnectionSnapshot,
  type TelemetryInspectableConnection,
} from "./ws-telemetry";

export class WebSocketLocalConnectionStore {
  private readonly connections = new Map<string, WebSocketFrameConnection>();

  register(connection: WebSocketFrameConnection): void {
    this.connections.set(connection.id, connection);
  }

  unregister(connectionId: string): void {
    this.connections.delete(connectionId);
  }

  getConnection(connectionId: string): WebSocketFrameConnection | undefined {
    return this.connections.get(connectionId);
  }

  getConnections(connectionIds: string[]): WebSocketFrameConnection[] {
    const targets: WebSocketFrameConnection[] = [];
    const seen = new Set<string>();

    for (const connectionId of connectionIds) {
      if (seen.has(connectionId)) {
        continue;
      }
      seen.add(connectionId);

      const connection = this.connections.get(connectionId);
      if (!connection || connection.closed) {
        continue;
      }

      targets.push(connection);
    }

    return targets;
  }

  getTelemetrySnapshot(): WebSocketTelemetryConnectionSnapshot {
    const snapshot: WebSocketTelemetryConnectionSnapshot = {
      pendingInboundMessages: 0,
      pendingOutboundMessages: 0,
      socketBufferedBytes: 0,
    };

    for (const connection of this.connections.values()) {
      if (!isTelemetryInspectableConnection(connection)) {
        continue;
      }

      const connectionSnapshot = connection.getTelemetrySnapshot();
      snapshot.pendingInboundMessages += connectionSnapshot.pendingInboundMessages;
      snapshot.pendingOutboundMessages += connectionSnapshot.pendingOutboundMessages;
      snapshot.socketBufferedBytes += connectionSnapshot.socketBufferedBytes;
    }

    return snapshot;
  }

  closeAll(code?: number, reason?: string): void {
    // close 도중 unregister가 Map을 바꾸므로 복사본을 순회한다
    for (const connection of Array.from(this.connections.values())) {
      connection.close(code, reason);
    }
  }
}

function isTelemetryInspectableConnection(
  connection: WebSocketFrameConnection,
): connection is WebSocketFrameConnection & TelemetryInspectableConnection {
  return "getTelemetrySnapshot" in connection && isFunctionValue(connection.getTelemetrySnapshot);
}
