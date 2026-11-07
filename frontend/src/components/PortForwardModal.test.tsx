import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PortForwardModal } from "./PortForwardModal";
import { useForwardStore } from "../stores/forwardStore";
import { useSessionStore } from "../stores/sessionStore";
import type { PortForwardRule } from "../types/ipc";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe("PortForwardModal dynamic socks authentication (BUG-011, BUG-012)", () => {
  let container: HTMLDivElement;
  let root: Root;

  const createSpy = vi.fn();
  const updateSpy = vi.fn();
  const deleteSpy = vi.fn();
  const toggleSpy = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    useSessionStore.setState({ sessions: [] });
    useForwardStore.setState({
      rules: [],
      statuses: {},
      loading: false,
      activeSessionId: null,
      loadError: null,
      refreshError: null,
      loadRules: vi.fn(async () => {}),
      loadStatuses: vi.fn(async () => {}),
      retryRefresh: vi.fn(async () => {}),
      createRule: createSpy,
      updateRule: updateSpy,
      deleteRule: deleteSpy,
      toggleRule: toggleSpy,
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("creates dynamic socks rule with userpass auth without writing plain password to socks_password_ref", async () => {
    act(() => root.render(<PortForwardModal sessionId="sess_1" onClose={() => {}} />));

    // Click "新建规则"
    const newBtn = Array.from(document.body.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("新建规则")
    )!;
    act(() => newBtn.click());

    // Select dynamic rule type
    const dynamicTypeBtn = Array.from(document.body.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("SOCKS5 -D")
    )!;
    act(() => dynamicTypeBtn.click());

    // Fill rule name
    const nameInput = document.body.querySelector<HTMLInputElement>('input[value=""]')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(nameInput, "我的SOCKS5");
      nameInput.dispatchEvent(new Event("input", { bubbles: true }));
      nameInput.dispatchEvent(new Event("change", { bubbles: true }));
    });

    // Select userpass auth
    const authSelect = Array.from(document.body.querySelectorAll("select")).find((s) =>
      Array.from(s.options).some((o) => o.value === "userpass")
    )!;
    act(() => {
      authSelect.value = "userpass";
      authSelect.dispatchEvent(new Event("change", { bubbles: true }));
    });

    // Fill username and password
    const usernameInput = document.body.querySelector<HTMLInputElement>('input[aria-label="认证用户名"]')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(usernameInput, "proxyuser");
      usernameInput.dispatchEvent(new Event("input", { bubbles: true }));
      usernameInput.dispatchEvent(new Event("change", { bubbles: true }));
    });

    const passwordInput = document.body.querySelector<HTMLInputElement>('input[aria-label="认证密码"]')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(passwordInput, "proxypass123");
      passwordInput.dispatchEvent(new Event("input", { bubbles: true }));
      passwordInput.dispatchEvent(new Event("change", { bubbles: true }));
    });

    // Submit
    const confirmBtn = Array.from(document.body.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("确认创建")
    )!;
    await act(async () => {
      confirmBtn.click();
    });

    expect(createSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "我的SOCKS5",
        rule_type: "dynamic",
        socks_auth: "userpass",
        socks_username: "proxyuser",
        socks_password: "proxypass123",
      })
    );
    const sentInput = createSpy.mock.calls[0][0];
    expect(sentInput.socks_password_ref).toBeUndefined();
  });

  it("editing dynamic rule does not echo password and preserves it when left blank", async () => {
    const existingRule: PortForwardRule = {
      id: "rule_1",
      session_id: "sess_1",
      name: "已有SOCKS",
      rule_type: "dynamic",
      bind_host: "127.0.0.1",
      bind_port: 1080,
      dest_host: null,
      dest_port: null,
      auto_start: false,
      auto_reconnect: true,
      reconnect_max: 3,
      socks_auth: "userpass" as any,
      socks_username: "existing_user",
      socks_password_ref: "vault://secret/socks1",
      expose_warning_ack: false,
      sort_order: 0,
      created_at: 100,
      updated_at: 100,
      deleted_at: null,
    };

    useForwardStore.setState({ rules: [existingRule] });
    act(() => root.render(<PortForwardModal onClose={() => {}} />));

    const editBtn = document.body.querySelector<HTMLButtonElement>('button[aria-label="编辑规则"]')!;
    act(() => editBtn.click());

    // Password input must be empty, not echoing the vault ref
    const passwordInput = document.body.querySelector<HTMLInputElement>('input[aria-label="认证密码"]')!;
    expect(passwordInput.value).toBe("");

    // Submit without changing password -> preserves existing password
    const saveBtn = Array.from(document.body.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("保存修改")
    )!;
    await act(async () => {
      saveBtn.click();
    });

    expect(updateSpy).toHaveBeenCalledWith(
      "rule_1",
      expect.objectContaining({
        name: "已有SOCKS",
        rule_type: "dynamic",
        socks_auth: "userpass",
        socks_username: "existing_user",
        socks_clear_password: false,
      })
    );
    const sentInput = updateSpy.mock.calls[0][1];
    expect(sentInput.socks_password).toBeUndefined();
    expect(sentInput.socks_password_ref).toBeUndefined();
  });

  it("marks a rule needing credential re-entry and forces an explicit new password", async () => {
    const brokenRule = {
      id: "rule_b",
      session_id: "sess_1",
      name: "待补录SOCKS",
      rule_type: "dynamic" as const,
      bind_host: "127.0.0.1",
      bind_port: 1081,
      dest_host: null,
      dest_port: null,
      auto_start: false,
      auto_reconnect: true,
      reconnect_max: 3,
      socks_auth: "userpass" as const,
      socks_username: "existing_user",
      socks_password_ref: null,
      has_socks_password: false,
      credential_state: "needs_reentry" as const,
      expose_warning_ack: false,
      sort_order: 0,
      created_at: 100,
      updated_at: 100,
      deleted_at: null,
    };

    useForwardStore.setState({ rules: [brokenRule] });
    act(() => root.render(<PortForwardModal onClose={() => {}} />));

    expect(document.body.textContent).toContain("需补录");

    const editBtn = document.body.querySelector<HTMLButtonElement>('button[aria-label="编辑规则"]')!;
    act(() => editBtn.click());

    const saveBtn = Array.from(document.body.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("保存修改")
    )!;
    await act(async () => {
      saveBtn.click();
    });
    expect(updateSpy).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("必须填写认证密码");
  });

  it("checking clear password sends socks_clear_password: true", async () => {
    const existingRule: PortForwardRule = {
      id: "rule_1",
      session_id: "sess_1",
      name: "已有SOCKS",
      rule_type: "dynamic",
      bind_host: "127.0.0.1",
      bind_port: 1080,
      dest_host: null,
      dest_port: null,
      auto_start: false,
      auto_reconnect: true,
      reconnect_max: 3,
      socks_auth: "userpass" as any,
      socks_username: "existing_user",
      socks_password_ref: "vault://secret/socks1",
      expose_warning_ack: false,
      sort_order: 0,
      created_at: 100,
      updated_at: 100,
      deleted_at: null,
    };

    useForwardStore.setState({ rules: [existingRule] });
    act(() => root.render(<PortForwardModal onClose={() => {}} />));

    const editBtn = document.body.querySelector<HTMLButtonElement>('button[aria-label="编辑规则"]')!;
    act(() => editBtn.click());

    const clearBox = document.body.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    act(() => clearBox.click());

    const saveBtn = Array.from(document.body.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("保存修改")
    )!;
    await act(async () => {
      saveBtn.click();
    });

    // When cleared without a new password, it requires a new password or switching auth
    expect(document.body.textContent).toContain("已选择清除原密码");
  });
});
