import { describe, expect, it } from "vitest";
import type { Group, Session } from "../types/ipc";
import {
  buildGroupTree,
  countSessions,
  rebalanceOrders,
  sortOrderForIndex,
  wouldCreateCycle,
} from "./groupTree";

function group(id: string, parent_id: string | null, sort_order = 1024, name = id): Group {
  return {
    id,
    parent_id,
    name,
    kind: "session",
    sort_order,
    color: null,
    icon_key: null,
    expanded: true,
    notes: null,
    created_at: 0,
    updated_at: 0,
    deleted_at: null,
  };
}

function session(id: string, group_id: string | null, sort_order = 1024): Session {
  return {
    id,
    group_id,
    name: id,
    protocol: "ssh",
    host: "127.0.0.1",
    port: 22,
    username: "root",
    auth_method: "password",
    credential_id: null,
    ssh_key_id: null,
    host_key_policy: "accept_new",
    proxy_jump_json: null,
    proxy_id: null,
    terminal_profile_id: null,
    encoding: "utf-8",
    startup_command: null,
    working_dir: null,
    keepalive_sec: 30,
    keepalive_max_miss: 3,
    auto_reconnect: false,
    reconnect_max: 3,
    compression: false,
    agent_forwarding: false,
    x11_forwarding: false,
    tags_json: null,
    favorite: false,
    color: null,
    icon_key: null,
    notes: null,
    protocol_options_json: null,
    last_used_at: null,
    last_result: null,
    use_count: 0,
    sort_order,
    created_at: 0,
    updated_at: 0,
  } as Session;
}

describe("buildGroupTree", () => {
  it("按 parent_id 构建多级树并按 sort_order 排序", () => {
    const groups = [
      group("prod", null, 2048),
      group("test", null, 1024),
      group("prod-db", "prod", 1024),
    ];
    const sessions = [session("s1", "prod-db"), session("s2", null), session("s3", "test")];

    const model = buildGroupTree(groups, sessions);

    expect(model.roots.map((n) => n.group.id)).toEqual(["test", "prod"]);
    const prod = model.roots[1];
    expect(prod.children.map((n) => n.group.id)).toEqual(["prod-db"]);
    expect(prod.children[0].sessions.map((s) => s.id)).toEqual(["s1"]);
    expect(model.ungrouped.map((s) => s.id)).toEqual(["s2"]);
    expect(countSessions(prod)).toBe(1);
  });

  it("孤儿分组不会被丢弃", () => {
    const groups = [group("orphan", "already-deleted")];
    const model = buildGroupTree(groups, []);
    expect(model.roots.map((n) => n.group.id)).toContain("orphan");
  });
});

describe("wouldCreateCycle", () => {
  it("禁止把父分组拖进自己的后代", () => {
    const groups = [group("a", null), group("b", "a"), group("c", "b")];
    const model = buildGroupTree(groups, []);

    expect(wouldCreateCycle(model, "a", "b")).toBe(true);
    expect(wouldCreateCycle(model, "a", "c")).toBe(true);
    expect(wouldCreateCycle(model, "a", "a")).toBe(true);
    expect(wouldCreateCycle(model, "b", null)).toBe(false);
    expect(wouldCreateCycle(model, "c", "a")).toBe(false);
  });
});

describe("sortOrderForIndex", () => {
  it("相邻取中值，边界分别减半/加步进", () => {
    expect(sortOrderForIndex([], 0)).toBe(1024);
    expect(sortOrderForIndex([1024], 0)).toBe(512);
    expect(sortOrderForIndex([1024], 1)).toBe(2048);
    expect(sortOrderForIndex([1024, 2048], 1)).toBe(1536);
  });

  it("间隙耗尽时返回 null 以提示需要重排", () => {
    expect(sortOrderForIndex([1024, 1025], 1)).toBeNull();
    expect(rebalanceOrders(3)).toEqual([1024, 2048, 3072]);
  });
});
