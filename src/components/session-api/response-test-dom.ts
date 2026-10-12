import { afterAll, beforeAll } from "vitest";

// jsdom has no text layout; CodeMirror measures ranges during scrolling.
const originals = Object.getOwnPropertyDescriptors(Range.prototype);
beforeAll(() => {
  Object.defineProperties(Range.prototype, {
    getClientRects: { configurable: true, value: () => [] },
    getBoundingClientRect: { configurable: true, value: () => new DOMRect() }
  });
});
afterAll(() => {
  for (const key of ["getClientRects", "getBoundingClientRect"]) {
    if (originals[key]) Object.defineProperty(Range.prototype, key, originals[key]);
    else Reflect.deleteProperty(Range.prototype, key);
  }
});
