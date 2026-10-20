import { type z } from "zod";

export type WebSocketFrameEncoding =
  | { status: "encoded"; frame: string }
  | { status: "unknownEvent" }
  | { status: "invalidPayload" };

/**
 * outEvents 스키마로 payload를 검증하고 `{event, data}` frame 문자열로 인코딩한다.
 * 같은 스키마로 인코딩한 frame은 로컬·원격 수신자 모두에게 같은 바이트로 전달된다.
 */
export function encodeWebSocketFrame<Data>(
  outEvents: z.ZodObject,
  event: string,
  data: Data,
): WebSocketFrameEncoding {
  const schema = getEventSchema(outEvents, event);
  if (!schema) {
    return { status: "unknownEvent" };
  }

  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    return { status: "invalidPayload" };
  }

  return {
    status: "encoded",
    frame: JSON.stringify({
      event,
      data: parsed.data,
    }),
  };
}

function getEventSchema(outEvents: z.ZodObject, event: string): z.ZodType | undefined {
  const eventSchemas: Record<string, z.ZodType> = outEvents["shape"];
  return Object.hasOwn(eventSchemas, event) ? eventSchemas[event] : undefined;
}
