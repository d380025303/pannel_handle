const DEFAULT_EXCLUDED_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  ".idea",
  ".vscode",
  "node_modules",
  "dist",
  "release",
  "build",
  "target",
  "coverage",
  ".cache",
  ".vite"
]);

const MAX_FILE_RESULTS = 200;
const MAX_TEXT_RESULTS = 300;
const MAX_TEXT_FILE_SIZE = 1024 * 1024;
const MAX_FILE_VISITED_ENTRIES = 100000;
const MAX_TEXT_VISITED_ENTRIES = 30000;
const SEARCH_TIMEOUT_MS = 30000;

module.exports = {
  DEFAULT_EXCLUDED_DIRS,
  MAX_FILE_RESULTS,
  MAX_TEXT_RESULTS,
  MAX_TEXT_FILE_SIZE,
  MAX_FILE_VISITED_ENTRIES,
  MAX_TEXT_VISITED_ENTRIES,
  SEARCH_TIMEOUT_MS
};
