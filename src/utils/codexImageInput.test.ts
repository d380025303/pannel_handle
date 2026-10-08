import { describe, expect, it } from "vitest";
import { isCodexImageFile, supportsCodexImageInput } from "./codexImageInput";

describe("Codex image capabilities", () => {
  it.each([undefined, [], [""], ["text", "image"]])("allows compatible or unknown modalities %j", inputModalities => {
    expect(supportsCodexImageInput({ model: "m", models: [{ id: "m", inputModalities }] })).toBe(true);
  });
  it("restricts only the selected Codex model", () => {
    const models = [{ id: "text", inputModalities: ["text"] }, { id: "vision", inputModalities: ["image", "text"] }];
    expect(supportsCodexImageInput({ model: "text", models })).toBe(false);
    expect(supportsCodexImageInput({ model: "vision", models })).toBe(true);
    expect(supportsCodexImageInput({ model: "unknown", models })).toBe(true);
    expect(supportsCodexImageInput({ provider: "opencode", model: "text", models })).toBe(true);
  });
  it("matches the formats sent as localImage", () => {
    for (const ext of ["png", "JPG", "jpeg", "gif", "webp", "bmp"]) expect(isCodexImageFile(`file.${ext}`)).toBe(true);
    expect(isCodexImageFile("notes.txt")).toBe(false);
    expect(isCodexImageFile("drawing.svg")).toBe(false);
  });
});
