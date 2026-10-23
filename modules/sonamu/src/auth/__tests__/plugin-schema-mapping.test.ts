import { describe, expect, test } from "vitest";

import {
  admin,
  anonymous,
  apiKey,
  jwt,
  organization,
  passkey,
  phoneNumber,
  sso,
  twoFactor,
  username,
} from "../plugins/wrappers";

type PluginWithSchema = {
  schema?: Record<string, { fields?: Record<string, { fieldName?: string }> }>;
};

// Sonamu 엔티티는 snake_case 컬럼을 쓰므로, 래퍼가 매핑하지 않은 camelCase 필드는 런타임 SQL 오류가 된다.
function findUnmappedFields(plugin: PluginWithSchema): string[] {
  return Object.entries(plugin.schema ?? {}).flatMap(([model, definition]) =>
    Object.entries(definition.fields ?? {})
      .filter(([field, options]) => /[A-Z]/.test(options.fieldName ?? field))
      .map(([field]) => `${model}.${field}`),
  );
}

describe("better-auth 플러그인 래퍼 스키마 매핑", () => {
  const plugins = {
    admin: admin(),
    anonymous: anonymous(),
    apiKey: apiKey(),
    jwt: jwt(),
    organization: organization(),
    passkey: passkey(),
    phoneNumber: phoneNumber({ sendOTP: async () => undefined }),
    sso: sso(),
    twoFactor: twoFactor(),
    username: username(),
  } satisfies Record<string, PluginWithSchema>;

  test.each(Object.entries(plugins))(
    "%s 플러그인의 모든 필드가 snake_case 컬럼으로 매핑된다",
    (_name, plugin) => {
      expect(findUnmappedFields(plugin)).toEqual([]);
    },
  );
});
