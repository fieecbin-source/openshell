import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { Field, Input } from "./Field";

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });

it("shows a five-point star only while the required field is empty and keeps its accessible label", () => {
  for (const value of ["", "   ", "服务器", ""]) {
    act(() => root.render(<Field label="名称" required value={value}>
      <Input value={value} onChange={() => {}} />
    </Field>));
    expect(container.querySelector('[title="必填"]')?.textContent ?? "").toBe(value.trim() ? "" : "★");
    const input = container.querySelector("input")!;
    expect(input.getAttribute("aria-required")).toBe("true");
    expect(container.querySelector("label")!.htmlFor).toBe(input.id);
  }
});

it("keeps optional fields unmarked and validation errors visible", () => {
  act(() => root.render(<Field label="备注" error="输入内容过长"><Input value="" readOnly /></Field>));
  expect(container.querySelector('[title="必填"]')).toBeNull();
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("输入内容过长");
  expect(container.querySelector("[placeholder]")).toBeNull();
});
