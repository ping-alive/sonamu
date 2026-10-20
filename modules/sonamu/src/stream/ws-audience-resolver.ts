import { type WebSocketAudience } from "./ws-audience";
import { type WebSocketPresenceStore } from "./ws-presence-store";
import { parseWebSocketSessionNodeId } from "./ws-session-id";

/**
 * publish 대상 중 원격 노드를 찾는다. 로컬 대상은 registry 메모리로 해석하므로 여기서는 원격 노드만 다룬다.
 */
export class WebSocketAudienceResolver {
  constructor(
    private readonly options: {
      nodeId: string;
      presenceStore: WebSocketPresenceStore;
    },
  ) {}

  /**
   * `connections` audience는 세션 ID에 든 노드 ID로 store 조회 없이 라우팅한다.
   * 그 밖의 audience는 store.resolveRoute를 호출하며, 동기 throw도 rejection으로 바꾼다.
   */
  async resolveRemoteNodeIds(audience: WebSocketAudience): Promise<string[]> {
    if (audience.type === "connections") {
      const nodeIds = new Set<string>();
      for (const connectionId of audience.connectionIds) {
        const nodeId = parseWebSocketSessionNodeId(connectionId);
        if (nodeId !== undefined && nodeId !== this.options.nodeId) {
          nodeIds.add(nodeId);
        }
      }
      return [...nodeIds];
    }

    const plan = await Promise.resolve().then(() =>
      this.options.presenceStore.resolveRoute(audience, this.options.nodeId),
    );
    return [...new Set(plan.remoteNodeIds)].filter((nodeId) => nodeId !== this.options.nodeId);
  }
}
