import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    // testcontainers로 Redis 컨테이너를 띄우므로 기동/정리 시간을 넉넉히 잡습니다.
    testTimeout: 60_000,
    hookTimeout: 120_000,
    teardownTimeout: 120_000,
    // 파일마다 컨테이너를 띄우므로 Docker 부하를 줄이기 위해 파일을 순차 실행합니다.
    fileParallelism: false,
  },
});
