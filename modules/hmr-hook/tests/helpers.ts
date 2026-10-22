import path from "node:path";

import { getActiveTest } from "@japa/runner";
import { join } from "desm";
import { execaNode, type Message, type Options, type ResultPromise } from "execa";
import fs from "fs-extra";
import { pEvent } from "p-event";
import pTimeout from "p-timeout";

import { type FileChangeAction, type MessageChannelMessage } from "../src/types.js";

// 파일 변경 감지는 테스트가 담당하고, 자식 프로세스에는 syncer처럼 명시적으로 전달한다.
export const manualInvalidationSource = `
process.on('message', async (message) => {
  if (message.type !== 'test:invalidate') return
  const { hot } = await import('@sonamu-kit/hmr-hook')
  const paths = await hot.invalidateFile(message.path, message.action)
  process.send({ type: 'test:invalidate-done', paths })
})
`;

export const projectRoot = join(import.meta.url, "../");

interface PackageMetadata {
  name: string;
  bin?: string | Record<string, string>;
}

export async function fakeInstall(destination: string) {
  const packageMetadata: PackageMetadata = await fs.readJson(
    path.resolve(projectRoot, "package.json"),
  );
  const { name: packageName, bin = {} } = packageMetadata;

  await fs.ensureSymlink(projectRoot, path.resolve(destination, "node_modules", packageName));
  await fs.ensureSymlink(projectRoot, path.resolve(destination, "node_modules", "hot-hook"));

  if (Object.prototype.toString.call(bin) === "[object String]") {
    const binPath = String(bin);
    const binName = packageName;
    await fs.ensureSymlink(
      path.resolve(projectRoot, binPath),
      path.resolve(destination, "node_modules", ".bin", binName),
    );
    await fs.ensureSymlink(
      path.resolve(projectRoot, binPath),
      path.resolve(destination, "node_modules", ".bin", "hot-hook"),
    );
  } else {
    for (const [binName, binPath] of Object.entries(bin)) {
      await fs.ensureSymlink(
        path.resolve(projectRoot, binPath),
        path.resolve(destination, "node_modules", ".bin", binName),
      );
    }
  }
}

export async function createHandlerFile(options: { path: string; response: string }) {
  const activeTest = getActiveTest();
  if (!activeTest) throw new Error("No active test");

  const { path: handlerPath, response } = options;
  await activeTest.context.fs.create(
    handlerPath,
    `export default function(request, response) {
      response.writeHead(200, {'Content-Type': 'text/plain'})
      response.end('${response}')
    }`,
  );
}

/** 자식 프로세스가 process.send로 보내는 테스트 메시지의 공통 형태. 각 테스트가 type별 payload를 좁혀 쓴다 */
export type IpcMessage = { type: string; paths?: string[]; [key: string]: Message | undefined };

function isIpcMessage(value: Message): value is IpcMessage {
  if (value === null || Array.isArray(value) || !(value instanceof Object)) return false;
  return "type" in value && Object.prototype.toString.call(value.type) === "[object String]";
}

export function runProcess(scriptPath: string, options?: Options) {
  const activeTest = getActiveTest();
  if (!activeTest) {
    throw new Error("Cannot run a process outside of a test");
  }

  // 반환 타입이 execa 내부 타입을 참조하지 않도록 선언 타입을 고정한다
  const child: ResultPromise = execaNode(scriptPath, {
    nodeOptions: [],
    buffer: false,
    ...options,
  });
  // execa 10은 IPC를 EventEmitter가 아니라 getEachMessage() 반복자로 노출한다
  const inbox: IpcMessage[] = [];
  const waiters = new Set<(message: IpcMessage) => void>();
  void (async () => {
    try {
      if (!child.getEachMessage) return;
      for await (const message of child.getEachMessage()) {
        if (!isIpcMessage(message)) continue;
        const typed = message;
        inbox.push(typed);
        for (const waiter of waiters) waiter(typed);
      }
    } catch {
      // 프로세스 종료로 채널이 닫히면 반복자가 거부된다
    }
  })();
  activeTest.cleanup(() => void child.kill());

  // child.stdout?.pipe(process.stdout)
  // child.stderr?.pipe(process.stderr)

  return {
    child,
    async invalidateFile(filePath: string, action: FileChangeAction = "change") {
      const startIndex = inbox.length;
      // 완료 응답까지 기다려 다음 import와 수동 무효화 사이의 순서를 보장한다.
      const done = new Promise<{ paths: string[] }>((resolve, reject) => {
        const timer = setTimeout(() => {
          waiters.delete(waiter);
          reject(new Error("Timeout waiting for test:invalidate-done"));
        }, 2_000);
        function waiter(message: IpcMessage) {
          if (message.type !== "test:invalidate-done" || !Array.isArray(message.paths)) return;
          clearTimeout(timer);
          waiters.delete(waiter);
          resolve({ paths: message.paths.map(String) });
        }
        waiters.add(waiter);
      });
      if (!child.sendMessage) throw new Error("IPC not available");
      await child.sendMessage({ type: "test:invalidate", path: filePath, action });
      const { paths } = await done;
      return {
        paths,
        messages: inbox
          .slice(startIndex)
          .filter((message): message is MessageChannelMessage =>
            message.type.startsWith("hmr-hook:"),
          ),
      };
    },
    /** type이 일치하는 다음 IPC 메시지를 기다린다 */
    waitForMessage<T extends IpcMessage>(type: string, timeout = 2_000): Promise<T> {
      const found = inbox.find((message) => message.type === type);
      if (found) {
        // SAFETY: type 필드가 일치하는 메시지를 호출자가 요청한 payload 형태로 간주한다
        return Promise.resolve(found as T);
      }
      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
          waiters.delete(waiter);
          reject(new Error(`Timeout waiting for message "${type}"`));
        }, timeout);
        function waiter(message: IpcMessage) {
          if (message.type !== type) return;
          clearTimeout(timer);
          waiters.delete(waiter);
          // SAFETY: type 필드가 일치하는 메시지를 호출자가 요청한 payload 형태로 간주한다
          resolve(message as T);
        }
        waiters.add(waiter);
      });
    },
    async waitForOutput(output: string, timeout = 10_000) {
      const waitUntilOutput = async () => {
        // 린트 리팩토링: execa로 생성된 child는 항상 stdout 존재
        if (!child.stdout) throw new Error("stdout not available");
        // p-event 8부터 필터 인자가 unknown이라 stdout chunk(Buffer | string)로 좁힌다
        await pEvent(child.stdout, "data", (value: Buffer | string) =>
          value.toString().includes(output),
        );
      };

      return await pTimeout(waitUntilOutput(), {
        milliseconds: timeout,
        message: `Timeout waiting for "${output}"`,
      });
    },

    async waitForExit() {
      await child;
    },
  };
}
