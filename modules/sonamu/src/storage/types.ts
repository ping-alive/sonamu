import { type DriverContract } from "flydrive/types";

/** storage.drivers에 등록한 디스크 이름. 드라이버 종류(fs·s3)와는 독립적이다. */
export type DiskName = string;

/**
 * Stream 모드에서 파일 키 생성 함수 타입
 */
export type KeyGenerator = (file: {
  filename: string;
  mimetype: string;
}) => string | Promise<string>;

/**
 * Storage 설정 타입
 */
export type StorageConfig = {
  /** 디스크별 드라이버 팩토리 */
  drivers: Record<DiskName, () => DriverContract>;
  /** stream 모드의 전역 키 생성 함수 (생략 시 timestamp-random 기본값) */
  keyGenerator?: KeyGenerator;
};
