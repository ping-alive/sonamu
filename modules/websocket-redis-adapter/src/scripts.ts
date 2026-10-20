import { createHash } from "node:crypto";

export type LuaScript = {
  name: string;
  source: string;
  sha: string;
};

function defineScript(name: string, source: string): LuaScript {
  return { name, source, sha: createHash("sha1").update(source).digest("hex") };
}

/**
 * 세션 presence JSON에서 count 해시 기여분을 계산하는 공통 Lua 함수.
 * - 비활성 세션은 아무 count에도 기여하지 않는다.
 * - room/user 필드는 `<namespace 바이트 길이>:<namespace>:<id>` 형식이라 구분자가 namespace에 들어 있어도 모호하지 않다.
 *   countAudience 스크립트의 fieldOf()와 같은 형식을 유지해야 한다.
 * - user id는 JS에서 타입 태그를 붙인 문자열(`n:1`, `s:1`)이라 1과 "1"이 다른 필드가 된다.
 * - 키 이름은 항상 KEYS에서만 가져온다(호출자 keyPrefix와 Cluster slot 규칙을 지키기 위해).
 */
const CONTRIBUTIONS_LUA = `
local function fieldOf(namespace, id)
  return string.len(namespace) .. ':' .. namespace .. ':' .. id
end

local function addContributions(deltas, keys, json, delta)
  if not json or json == '' then
    return
  end
  local ok, session = pcall(cjson.decode, json)
  if not ok or type(session) ~= 'table' or session.active ~= true or type(session.namespace) ~= 'string' then
    return
  end
  local namespace = session.namespace
  local contributions = { { keys.namespaces, namespace } }
  if type(session.rooms) == 'table' then
    for _, roomId in ipairs(session.rooms) do
      if type(roomId) == 'string' then
        table.insert(contributions, { keys.rooms, fieldOf(namespace, roomId) })
      end
    end
  end
  if type(session.userId) == 'string' then
    table.insert(contributions, { keys.users, fieldOf(namespace, session.userId) })
  end
  for _, contribution in ipairs(contributions) do
    local key = contribution[1]
    local field = contribution[2]
    local byKey = deltas[key]
    if not byKey then
      byKey = {}
      deltas[key] = byKey
    end
    byKey[field] = (byKey[field] or 0) + delta
  end
end
`;

const NODE_KEYS_LUA = `
local keys = { sessions = KEYS[1], rooms = KEYS[2], users = KEYS[3], namespaces = KEYS[4] }
`;

/**
 * 세션 하나의 상태를 메모리 snapshot으로 맞춘다(upsert/삭제).
 * Redis에 남아 있던 이전 JSON의 기여분을 빼고 새 JSON의 기여분을 더하므로, 이전 쓰기가 유실됐어도 count가 세션 상태와 어긋나지 않는다.
 * KEYS: sessions, rooms, users, namespaces / ARGV: sessionId, presence JSON(빈 문자열이면 삭제), keyTtlMs
 */
export const APPLY_SESSION_SCRIPT = defineScript(
  "applySession",
  `${CONTRIBUTIONS_LUA}${NODE_KEYS_LUA}
local sessionId = ARGV[1]
local nextJson = ARGV[2]
local ttl = tonumber(ARGV[3])

local deltas = {}
local previous = redis.call('HGET', keys.sessions, sessionId)
if previous then
  addContributions(deltas, keys, previous, -1)
end
addContributions(deltas, keys, nextJson, 1)

for key, fields in pairs(deltas) do
  for field, delta in pairs(fields) do
    if delta ~= 0 then
      local count = redis.call('HINCRBY', key, field, delta)
      if count <= 0 then
        redis.call('HDEL', key, field)
      end
    end
  end
end

if nextJson ~= '' then
  redis.call('HSET', keys.sessions, sessionId, nextJson)
elseif previous then
  redis.call('HDEL', keys.sessions, sessionId)
end

for index = 1, 4 do
  redis.call('PEXPIRE', KEYS[index], ttl)
end
return 1
`,
);

/**
 * 노드 키 4개를 지우고 메모리 snapshot으로 다시 쓴다. 쓰기 실패나 failover 뒤의 불일치(고스트 엔트리 포함)를 한 번에 정리한다.
 * KEYS: sessions, rooms, users, namespaces / ARGV: keyTtlMs, (sessionId, presence JSON) 반복
 */
export const REBUILD_NODE_SCRIPT = defineScript(
  "rebuildNode",
  `${CONTRIBUTIONS_LUA}${NODE_KEYS_LUA}
local ttl = tonumber(ARGV[1])
redis.call('DEL', KEYS[1], KEYS[2], KEYS[3], KEYS[4])

local deltas = {}
for index = 2, #ARGV, 2 do
  redis.call('HSET', keys.sessions, ARGV[index], ARGV[index + 1])
  addContributions(deltas, keys, ARGV[index + 1], 1)
end

for key, fields in pairs(deltas) do
  for field, count in pairs(fields) do
    if count > 0 then
      redis.call('HSET', key, field, count)
    end
  end
end

for index = 1, 4 do
  redis.call('PEXPIRE', KEYS[index], ttl)
end
return 1
`,
);

/**
 * 한 노드에서 audience 조건에 맞는 활성 세션 수를 센다. 세션 목록은 읽지 않고 count 해시만 읽는다.
 * namespace가 없거나 빈 문자열인 조건은 core와 같이 모든 namespace로 보고, 그 노드의 namespaces 해시 필드(활성 namespace 목록)로 펼친다.
 * KEYS: rooms, users, namespaces / ARGV: 조건 JSON 배열 [{ k: "all" | "room" | "user", ns?, id? }]
 */
export const COUNT_AUDIENCE_SCRIPT = defineScript(
  "countAudience",
  `
local roomsKey = KEYS[1]
local usersKey = KEYS[2]
local namespacesKey = KEYS[3]
local leaves = cjson.decode(ARGV[1])

local function fieldOf(namespace, id)
  return string.len(namespace) .. ':' .. namespace .. ':' .. id
end

local function countOf(key, field)
  return tonumber(redis.call('HGET', key, field)) or 0
end

local activeNamespaces = nil
local function namespaces()
  if activeNamespaces == nil then
    activeNamespaces = redis.call('HKEYS', namespacesKey)
  end
  return activeNamespaces
end

local total = 0
for _, leaf in ipairs(leaves) do
  local namespace = leaf.ns
  if leaf.k == 'all' then
    if type(namespace) == 'string' and namespace ~= '' then
      total = total + countOf(namespacesKey, namespace)
    else
      for _, name in ipairs(namespaces()) do
        total = total + countOf(namespacesKey, name)
      end
    end
  else
    local key = roomsKey
    if leaf.k == 'user' then
      key = usersKey
    end
    if type(namespace) == 'string' and namespace ~= '' then
      total = total + countOf(key, fieldOf(namespace, leaf.id))
    else
      for _, name in ipairs(namespaces()) do
        total = total + countOf(key, fieldOf(name, leaf.id))
      end
    end
  end
end
return total
`,
);
