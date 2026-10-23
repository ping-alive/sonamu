import { knex, type Knex } from "knex";
import { afterAll, describe, expect, it, vi } from "vitest";

import { Puri } from "../puri";

type Schema = { users: { id: number; name: string; nickname: string | null; payload: object } };
const db = knex({ client: "pg" });
const query = () => new Puri<Schema, Schema, Schema["users"]>(db, "users");

type RawRow = { [column: string]: string | number | boolean | null | RawRow[] };

function result(
  builder: Knex.QueryBuilder,
  rows: RawRow | RawRow[] | undefined,
  presence: Record<string, readonly boolean[]> = {},
) {
  if (vi.isMockFunction(builder.clone)) builder.clone.mockRestore();
  const clone = builder.clone.bind(builder);
  vi.spyOn(builder, "clone").mockImplementation(() => {
    const cloned = clone();
    result(cloned, rows, presence);
    return cloned;
  });
  vi.spyOn(builder, "then").mockImplementation((fulfilled, rejected) => {
    const markers = [
      ...builder.toQuery().matchAll(/"([^"]+)"\.\* IS DISTINCT FROM NULL AS "([^"]+)"/g),
    ];
    const withPresence = (row: RawRow, index: number) => ({
      ...row,
      ...Object.fromEntries(
        markers.map(([, alias, column]) => [column, presence[alias]?.[index] ?? true]),
      ),
    });
    const output = Array.isArray(rows)
      ? rows.map(withPresence)
      : rows
        ? withPresence(rows, 0)
        : rows;
    return Promise.resolve(output).then(fulfilled, rejected);
  });
}

afterAll(() => db.destroy());

describe("Puri 중첩 select 결과", () => {
  it("중첩 select 별칭만 복원하고 평평한 별칭과 JSON 값은 보존한다", async () => {
    const selected = query().select({
      user: { id: "users.id", data: "users.payload" },
      literal__name: "users.name",
      payload: "users.payload",
    });
    const payload = [{ arbitrary__key: "원본" }];
    result(selected.rawQuery(), [
      { user__id: 1, user__data: payload, literal__name: "이름", payload },
    ]);
    const rows = await selected;
    expect(rows).toEqual([{ user: { id: 1, data: payload }, literal__name: "이름", payload }]);
    expect(rows[0]?.user.data).toBe(payload);
  });

  it("중첩 select의 빈 JSON 배열을 관계 없음으로 바꾸지 않는다", async () => {
    const selected = query().select({ user: { data: "users.payload" } });
    result(selected.rawQuery(), [{ user__data: [] }]);
    expect(await selected).toEqual([{ user: { data: [] } }]);
  });

  it("중첩 단계마다 null 관계를 복원하고 id가 없는 그룹도 처리한다", async () => {
    const selected = query()
      .leftJoin({ user: "users" }, (join) => join.on("users.id", "user.id"))
      .leftJoin({ user__detail: "users" }, (join) => join.on("users.id", "user__detail.id"))
      .select({ user: { id: "user.id", detail: { name: "user__detail.name" } } });
    result(
      selected.rawQuery(),
      [
        { user__id: 1, user__detail__name: null },
        { user__id: null, user__detail__name: "무시할 값" },
      ],
      { user: [true, false], user__detail: [false, true] },
    );
    expect(await selected).toEqual([{ user: { id: 1, detail: null } }, { user: null }]);
  });

  it("nullable 필드만 선택한 일반 그룹은 null로 축약하지 않는다", async () => {
    const selected = query().select({ profile: { nickname: "users.nickname" } });
    result(selected.rawQuery(), [{ profile__nickname: null }]);
    expect(await selected).toEqual([{ profile: { nickname: null } }]);
  });

  it("LEFT JOIN 별칭과 다른 이름으로 묶은 그룹은 객체로 유지한다", async () => {
    const selected = query()
      .leftJoin({ colleague: "users" }, (join) => join.on("users.id", "colleague.id"))
      .select({
        profile: { nickname: "colleague.nickname" },
        colleague: { nickname: "colleague.nickname" },
      });
    result(selected.rawQuery(), [{ profile__nickname: null, colleague__nickname: null }], {
      colleague: [false],
    });
    expect(await selected).toEqual([{ profile: { nickname: null }, colleague: null }]);
  });

  it("INNER JOIN 별칭과 같은 그룹도 nullable 필드를 보존한다", async () => {
    const selected = query()
      .join({ colleague: "users" }, "users.id", "colleague.id")
      .select({ colleague: { nickname: "colleague.nickname" } });
    result(selected.rawQuery(), [{ colleague__nickname: null }]);
    expect(await selected).toEqual([{ colleague: { nickname: null } }]);
  });

  it("선택한 값이 모두 null이어도 실제 LEFT JOIN 행이 있으면 객체를 유지한다", async () => {
    const selected = query()
      .leftJoin({ colleague: "users" }, (join) => join.on("users.id", "colleague.id"))
      .select({ colleague: { nickname: "colleague.nickname" } });
    result(selected.rawQuery(), [{ colleague__nickname: null }, { colleague__nickname: null }], {
      colleague: [true, false],
    });
    expect(await selected).toEqual([{ colleague: { nickname: null } }, { colleague: null }]);
    expect(selected.toQuery()).not.toContain("__sonamu_presence_");
    expect(await selected.rawQuery()).toEqual([
      { colleague__nickname: null },
      { colleague__nickname: null },
    ]);
  });

  it("그룹화한 no-id projection은 SQL 열을 추가하지 않고 객체를 유지한다", async () => {
    const selected = query()
      .leftJoin({ colleague: "users" }, (join) => join.on("users.id", "colleague.id"))
      .select({ colleague: { nickname: "colleague.nickname" } })
      .groupBy("colleague.nickname");
    result(selected.rawQuery(), [{ colleague__nickname: null }], { colleague: [false] });
    expect(await selected).toEqual([{ colleague: { nickname: null } }]);
  });

  it.each([false, true])(
    "다른 이름의 관계 그룹도 id 원본 LEFT JOIN을 따른다 (원시 표현식: %s)",
    async (raw) => {
      const selected = query()
        .leftJoin({ staffs: "users" }, (join) => join.on("users.id", "staffs.id"))
        .select({ manager: { id: "staffs.id", name: "staffs.name" } });
      if (raw) selected.appendSelect({ total: Puri.rawNumber("(SELECT COUNT(*) FROM users)") });
      result(
        selected.rawQuery(),
        [
          { manager__id: 1, manager__name: "담당자" },
          { manager__id: null, manager__name: null },
        ],
        { staffs: [true, false] },
      );
      expect(await selected.clone()).toEqual([
        { manager: { id: 1, name: "담당자" } },
        { manager: null },
      ]);
    },
  );

  it("관계 id 선택을 clear한 뒤 일반 nullable id 그룹을 선택하면 관계 의미도 지운다", async () => {
    const selected = query()
      .leftJoin({ staffs: "users" }, (join) => join.on("users.id", "staffs.id"))
      .select({ manager: { id: "staffs.id" } })
      .clear("select")
      .select({ manager: { id: "users.nickname" } });
    result(selected.rawQuery(), [{ manager__id: null }]);
    expect(await selected).toEqual([{ manager: { id: null } }]);
  });

  it("객체 키 안의 구분자는 중첩 경로로 다시 해석하지 않는다", async () => {
    const selected = query().select({ user__profile: { display__name: "users.name" } });
    result(selected.rawQuery(), [{ user__profile__display__name: "이름" }]);
    expect(await selected).toEqual([{ user__profile: { display__name: "이름" } }]);
  });

  it.each(["then", "catch", "finally"] as const)(
    "%s 실행에서도 중첩 결과를 반환한다",
    async (method) => {
      const selected = query().select({ user: { id: "users.id" } });
      result(selected.rawQuery(), [{ user__id: 1 }]);
      const rows =
        method === "then"
          ? await selected.then()
          : method === "catch"
            ? await selected.catch()
            : await selected.finally();
      expect(rows).toEqual([{ user: { id: 1 } }]);
    },
  );

  it.each(["then", "catch", "finally"] as const)(
    "first의 %s 실행과 조회 결과 없음도 처리한다",
    async (method) => {
      const selected = query()
        .select({ user: { id: "users.id" } })
        .first();
      result(selected.knexQuery, { user__id: 1 });
      const row =
        method === "then"
          ? await selected.then()
          : method === "catch"
            ? await selected.catch()
            : await selected.finally();
      expect(row).toEqual({ user: { id: 1 } });
      result(selected.knexQuery, undefined);
      expect(await selected).toBeUndefined();
    },
  );

  it.each(["select", "columns"] as const)(
    "clone과 appendSelect는 중첩 경로를 보존하고 clear(%s)는 복제본에만 적용된다",
    async (statement) => {
      const original = query().select({ user: { id: "users.id" } });
      const cloned = original.clone().appendSelect({ detail: { name: "users.name" } });
      result(cloned.rawQuery(), [{ user__id: 1, detail__name: "이름" }]);
      expect(await cloned).toEqual([{ user: { id: 1 }, detail: { name: "이름" } }]);
      cloned.clear(statement).select({ user__id: "users.id" });
      result(cloned.rawQuery(), [{ user__id: 2 }]);
      expect(await cloned).toEqual([{ user__id: 2 }]);
      result(original.rawQuery(), [{ user__id: 1 }]);
      expect(await original).toEqual([{ user: { id: 1 } }]);
    },
  );

  it("rawQuery는 기존의 평평한 SQL 결과를 그대로 반환한다", async () => {
    const selected = query().select({ user: { id: "users.id" } });
    result(selected.rawQuery(), [{ user__id: 1 }]);
    expect(await selected.rawQuery()).toEqual([{ user__id: 1 }]);
  });
});
