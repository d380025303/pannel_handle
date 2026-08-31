import { describe, expect, it } from "vitest";
import type { TerminalSession } from "../vite-env";
import { matchesSessionSearch } from "./sessionSearch";

const session: TerminalSession = {
  id: "ssh-session",
  title: "Production API",
  shell: "ssh",
  cwd: "/srv/application",
  createdAt: 1,
  type: "ssh",
  tags: ["Customer-A"],
  wslDistro: "Ubuntu-24.04",
  sshConfig: {
    host: "server.example.com",
    username: "deploy"
  }
};

describe("matchesSessionSearch", () => {
  it.each([
    "production",
    "SSH",
    "/srv/app",
    "ubuntu",
    "server.example.com",
    "DEPLOY",
    "customer-a"
  ])("matches the existing session-library fields for %s", (query) => {
    expect(matchesSessionSearch(session, query)).toBe(true);
  });

  it("trims the query and rejects unrelated text", () => {
    expect(matchesSessionSearch(session, "  production  ")).toBe(true);
    expect(matchesSessionSearch(session, "frontend")).toBe(false);
  });
});
