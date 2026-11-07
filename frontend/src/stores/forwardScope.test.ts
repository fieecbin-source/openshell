import { beforeEach, expect, it, vi } from "vitest";
import { forwardList, forwardListStatuses } from "../lib/ipc";
import { useForwardStore } from "./forwardStore";

vi.mock("../lib/ipc", () => ({
  forwardList: vi.fn(), forwardListStatuses: vi.fn(), forwardCreate: vi.fn(),
  forwardUpdate: vi.fn(), forwardDelete: vi.fn(), forwardStart: vi.fn(), forwardStop: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(forwardList).mockResolvedValue([]);
  vi.mocked(forwardListStatuses).mockResolvedValue({});
  useForwardStore.setState({ rules: [], statuses: {}, loading: false, activeSessionId: null });
});

it("returns to the global list after a session-scoped dialog", async () => {
  await useForwardStore.getState().loadRules("session-a");
  await useForwardStore.getState().loadRules();
  expect(forwardList).toHaveBeenLastCalledWith(undefined);
  expect(useForwardStore.getState().activeSessionId).toBeNull();
});

it("preserves the chosen session when refreshing after each mutation", async () => {
  const store = useForwardStore.getState();
  for (const mutate of [
    () => store.createRule({ name: "new", bind_port: 1080 }),
    () => store.updateRule("rule", { name: "changed", bind_port: 1080 }),
    () => store.deleteRule("rule"),
  ]) {
    await store.loadRules("session-a");
    await mutate();
    expect(forwardList).toHaveBeenLastCalledWith("session-a");
  }
});
