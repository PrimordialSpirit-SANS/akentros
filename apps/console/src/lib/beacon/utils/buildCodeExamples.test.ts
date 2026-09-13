import { describe, expect, it } from "vitest";
import { buildCodeExamples } from "./buildCodeExamples";

const API_ROOT = "https://api.example.com/api/ai/v1";
const MODEL = "beacon-mini";

describe("buildCodeExamples", () => {
  it("returns all four languages", () => {
    const examples = buildCodeExamples(API_ROOT, MODEL);
    expect(Object.keys(examples).sort()).toEqual(["curl", "javascript", "python", "typescript"]);
  });

  it("embeds the chat completions endpoint and model into every example", () => {
    const examples = buildCodeExamples(API_ROOT, MODEL);
    expect(examples.curl.code).toContain(`${API_ROOT}/chat/completions`);
    for (const example of Object.values(examples)) {
      expect(example.code).toContain(API_ROOT);
      expect(example.code).toContain(MODEL);
      expect(example.label).not.toBe("");
      expect(example.language).not.toBe("");
    }
  });

  it("uses bearer authorization in the curl example", () => {
    const examples = buildCodeExamples(API_ROOT, MODEL);
    expect(examples.curl.code).toContain("Authorization: Bearer $BEACON_API_KEY");
  });

  it("requests streaming in every example", () => {
    const examples = buildCodeExamples(API_ROOT, MODEL);
    expect(examples.curl.code).toContain('"stream": true');
    expect(examples.javascript.code).toContain("stream: true");
    expect(examples.typescript.code).toContain("stream: true");
    expect(examples.python.code).toContain("stream=True");
  });
});
