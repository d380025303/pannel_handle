import { createRequire } from "node:module";
import { expect, it } from "vitest";
const require = createRequire(import.meta.url);
const { toMobileGraphicalSnapshot } = require("./mobile-graphical-snapshot.cjs");
it("passes model image capabilities to the phone without guessing missing fields", () => {
  const value = toMobileGraphicalSnapshot({ models: [{ id: "text", inputModalities: ["text"] }, { id: "old" }] });
  expect(value.models[0].inputModalities).toEqual(["text"]);
  expect(value.models[1].inputModalities).toBeUndefined();
});
