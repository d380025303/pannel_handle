import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createLaunchTemplateStore } from "./launch-template-store.cjs";

function createStore() {
  const directory = mkdtempSync(path.join(tmpdir(), "pannel-handle-launch-templates-"));
  const templatesFile = path.join(directory, "launch-templates.json");
  let timestamp = 100;
  let id = 0;
  const store = createLaunchTemplateStore({
    templatesFile,
    now: () => ++timestamp,
    createId: () => `launch-${++id}`
  });
  return { store, templatesFile };
}

describe("launch template store", () => {
  it.each([
    ["create", (store) => store.create({ name: "Failed", sessionTemplateIds: ["session-3"] })],
    ["update", (store, first) => store.update(first.id, { name: "Changed", sessionTemplateIds: ["session-3"] })],
    ["remove", (store, first) => store.remove(first.id)],
    ["removeSessionTemplate", (store) => store.removeSessionTemplate("session-1")]
  ])("preserves memory and persisted data after a failed %s and a later successful write", (_operation, mutate) => {
    let persisted;
    let failWrites = false;
    const writeError = new Error("attempt to write a readonly database");
    const dataStore = {
      read: () => structuredClone(persisted),
      write: (_file, value) => {
        if (failWrites) throw writeError;
        persisted = structuredClone(value);
      }
    };
    let id = 0;
    let timestamp = 100;
    const store = createLaunchTemplateStore({
      templatesFile: "launch-templates.json",
      dataStore,
      createId: () => `launch-${++id}`,
      now: () => ++timestamp
    });
    const first = store.create({ name: "A", sessionTemplateIds: ["session-1", "session-2"] });
    store.create({ name: "Other", sessionTemplateIds: ["session-1"] });
    const before = store.getAll();
    const persistedBefore = structuredClone(persisted);

    failWrites = true;
    expect(() => mutate(store, first)).toThrow(writeError);
    expect(store.getAll()).toEqual(before);
    expect(store.get(first.id)).toEqual(first);
    expect(persisted).toEqual(persistedBefore);

    failWrites = false;
    const created = store.create({ name: "B", sessionTemplateIds: [] });
    expect(store.getAll()).toEqual([...before, created]);
    expect(persisted.launchTemplates).toEqual([...before, created]);
    const reloaded = createLaunchTemplateStore({ templatesFile: "launch-templates.json", dataStore });
    expect(reloaded.load()).toEqual([...before, created]);
  });

  it("loads an empty library when the file does not exist", () => {
    const { store } = createStore();
    expect(store.load()).toEqual([]);
  });

  it("persists ordered, de-duplicated members and reloads them", () => {
    const { store, templatesFile } = createStore();
    store.load();

    const created = store.create({
      name: "  Daily work  ",
      sessionTemplateIds: ["2", "1", "2", "", "3"]
    });
    expect(created).toMatchObject({
      id: "launch-1",
      name: "Daily work",
      sessionTemplateIds: ["2", "1", "3"]
    });

    store.update(created.id, {
      name: "Daily work",
      sessionTemplateIds: ["3", "2", "1"]
    });

    const reloaded = createLaunchTemplateStore({ templatesFile });
    expect(reloaded.load()).toEqual([
      expect.objectContaining({ name: "Daily work", sessionTemplateIds: ["3", "2", "1"] })
    ]);
    expect(JSON.parse(readFileSync(templatesFile, "utf-8")).schemaVersion).toBe(1);
  });

  it("requires unique non-empty names ignoring case", () => {
    const { store } = createStore();
    store.load();
    store.create({ name: "Development", sessionTemplateIds: [] });

    expect(() => store.create({ name: " development ", sessionTemplateIds: [] }))
      .toThrow("already exists");
    expect(() => store.create({ name: "   ", sessionTemplateIds: [] }))
      .toThrow("name is required");
  });

  it("removes deleted session members while retaining empty launch templates", () => {
    const { store } = createStore();
    store.load();
    const first = store.create({ name: "One", sessionTemplateIds: ["session-1"] });
    const second = store.create({ name: "Two", sessionTemplateIds: ["session-1", "session-2"] });

    store.removeSessionTemplate("session-1");

    expect(store.get(first.id)?.sessionTemplateIds).toEqual([]);
    expect(store.get(second.id)?.sessionTemplateIds).toEqual(["session-2"]);
    expect(store.getAll()).toHaveLength(2);
  });
});
