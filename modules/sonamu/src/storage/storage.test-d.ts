import { describe, expectTypeOf, it } from "vitest";

import { type SonamuConfig } from "../api/config";
import { type UploadDecoratorOptions } from "../api/decorators";
import { Sonamu } from "../api/sonamu";
import {
  type BufferedFile,
  type DriverKey,
  drivers,
  StorageManager,
  type StorageConfig,
  StreamedFile,
} from "./index";

describe("스토리지 디스크 이름", () => {
  it("드라이버 종류와 독립적인 디스크 이름을 모든 업로드 경로에서 허용한다", () => {
    const factory = drivers.fs({ location: "/tmp", visibility: "public" });
    const storage = { drivers: { images: factory, private: factory } } satisfies StorageConfig;
    expectTypeOf(storage).toExtend<NonNullable<SonamuConfig["server"]["storage"]>>();
    const manager = new StorageManager(storage);
    expectTypeOf(manager.use).parameter(0).toEqualTypeOf<string>();
    expectTypeOf(Sonamu.storage.use).parameter(0).toEqualTypeOf<string>();
    expectTypeOf<BufferedFile["saveToDisk"]>().parameter(0).toEqualTypeOf<string>();
    expectTypeOf<StreamedFile["diskName"]>().toEqualTypeOf<string>();
    expectTypeOf<DriverKey>().toEqualTypeOf<"fs" | "s3">();
    const options = { consume: "stream", destination: "images" } satisfies UploadDecoratorOptions;
    expectTypeOf(options).toExtend<UploadDecoratorOptions>();
    expectTypeOf(
      new StreamedFile({
        filename: "image.jpg",
        mimetype: "image/jpeg",
        size: 1,
        url: "https://cdn.example.com/image.jpg",
        signedUrl: "",
        key: "image.jpg",
        diskName: "images",
      }),
    ).toEqualTypeOf<StreamedFile>();
  });

  it("fs나 s3라는 이름의 디스크를 반드시 설정할 필요가 없다", () => {
    const factory = drivers.fs({ location: "/tmp", visibility: "public" });
    expectTypeOf({ drivers: { images: factory } }).toExtend<StorageConfig>();
    expectTypeOf({ drivers: { fs: factory } }).toExtend<StorageConfig>();
    expectTypeOf({ drivers: { s3: factory } }).toExtend<StorageConfig>();
  });
});
