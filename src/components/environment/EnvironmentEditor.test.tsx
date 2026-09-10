import { describe, expect, it } from "vitest";
import { parseEnvironmentText } from "./EnvironmentEditor";

describe("environment paste", () => {
  it("keeps literal values, equals signs, empty strings and whitespace", () => {
    expect(parseEnvironmentText("# comment\r\n\r\nURL=a=b\nEMPTY=\nLITERAL= $(whoami) `test` ${HOME} ")).toEqual([
      { name: "URL", value: "a=b" }, { name: "EMPTY", value: "" }, { name: "LITERAL", value: " $(whoami) `test` ${HOME} " }
    ]);
    expect(() => parseEnvironmentText("export FOO")).toThrow();
  });
});
