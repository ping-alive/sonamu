import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { type MultipartFile } from "@fastify/multipart";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Sonamu } from "../../api/sonamu";
import { BufferedFile, drivers, StorageManager, StreamedFile } from "../index";

describe("이름 붙인 디스크", () => {
  const originalStorage = Sonamu["storageValue"];
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "sonamu-storage-"));
  });

  afterEach(async () => {
    Reflect.set(Sonamu, "storageValue", originalStorage);
    await rm(directory, { recursive: true, force: true });
  });

  it("버퍼 업로드와 스트림 파일 다운로드가 같은 이름의 디스크를 사용한다", async () => {
    const factory = vi.fn(
      drivers.fs({
        location: directory,
        visibility: "public",
        urlBuilder: {
          async generateURL(key) {
            return `https://cdn.example.com/${key}`;
          },
          async generateSignedURL(key) {
            return `https://cdn.example.com/${key}?signed`;
          },
        },
      }),
    );
    const manager = new StorageManager({ drivers: { images: factory } });
    Reflect.set(Sonamu, "storageValue", manager);
    expect(factory).not.toHaveBeenCalled();

    // SAFETY: BufferedFile 생성자가 읽는 필드는 filename과 mimetype뿐이며 raw는 이 테스트에서 사용하지 않는다.
    const multipart = { filename: "hello.txt", mimetype: "text/plain" } as MultipartFile;
    const buffer = new BufferedFile(multipart, Buffer.from("hello"));
    expect(await buffer.saveToDisk("images", "hello.txt")).toBe(
      "https://cdn.example.com/hello.txt",
    );
    expect(await readFile(path.join(directory, "hello.txt"), "utf8")).toBe("hello");
    const streamed = new StreamedFile({
      filename: "hello.txt",
      mimetype: "text/plain",
      size: 5,
      key: "hello.txt",
      diskName: "images",
      url: "https://cdn.example.com/hello.txt",
      signedUrl: "https://cdn.example.com/hello.txt?signed",
    });
    expect(streamed.diskName).toBe("images");
    expect(await streamed.download()).toEqual(Buffer.from("hello"));
    expect(factory).toHaveBeenCalledTimes(1);
    expect(() => manager.use("missing")).toThrow('Unknown disk: "missing". Available: images');
  });
});
