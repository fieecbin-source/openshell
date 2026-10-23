import { describe, it, expect } from "vitest";

describe("Snippet placeholder parsing logic", () => {
  it("should extract placeholders with default values", () => {
    const template = "docker logs -f --tail ${LINES:-100} ${CONTAINER_NAME}";
    const regex = /\$\{([a-zA-Z0-9_]+)(?::-(.*?))?\}/g;
    const matches: { name: string; defaultValue: string }[] = [];

    let match;
    while ((match = regex.exec(template)) !== null) {
      matches.push({ name: match[1], defaultValue: match[2] || "" });
    }

    expect(matches).toHaveLength(2);
    expect(matches[0]).toEqual({ name: "LINES", defaultValue: "100" });
    expect(matches[1]).toEqual({ name: "CONTAINER_NAME", defaultValue: "" });
  });

  it("should replace placeholders with user parameters", () => {
    let template = "curl -X POST http://${HOST:-localhost}:${PORT:-8080}/api";
    const params = [
      { name: "HOST", value: "192.168.1.50" },
      { name: "PORT", value: "9000" },
    ];

    for (const p of params) {
      const regex = new RegExp(`\\$\\{${p.name}(?::-.*?)?\\}`, "g");
      template = template.replace(regex, p.value);
    }

    expect(template).toBe("curl -X POST http://192.168.1.50:9000/api");
  });
});
