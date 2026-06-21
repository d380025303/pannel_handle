import { describe, expect, it } from "vitest";
import { filterSearchableSelectOptions, type SearchableSelectOption } from "./SearchableSelect";

const options: SearchableSelectOption[] = [
  { value: "main", label: "Main" },
  { value: "feature/search", label: "Feature Search", searchText: "remote origin" },
  { value: "C:\\Projects\\Panel", label: "Panel" }
];

describe("filterSearchableSelectOptions", () => {
  it("returns all options for an empty query", () => {
    expect(filterSearchableSelectOptions(options, "  ")).toEqual(options);
  });

  it("matches labels without regard to case", () => {
    expect(filterSearchableSelectOptions(options, "SEARCH")).toEqual([options[1]]);
  });

  it("matches text at any position", () => {
    expect(filterSearchableSelectOptions(options, "atur")).toEqual([options[1]]);
  });

  it("matches values and additional search text", () => {
    expect(filterSearchableSelectOptions(options, "projects")).toEqual([options[2]]);
    expect(filterSearchableSelectOptions(options, "origin")).toEqual([options[1]]);
  });

  it("returns no options when nothing matches", () => {
    expect(filterSearchableSelectOptions(options, "missing")).toEqual([]);
  });
});
