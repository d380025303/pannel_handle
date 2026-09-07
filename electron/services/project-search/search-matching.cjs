const { DEFAULT_EXCLUDED_DIRS } = require("./search-limits.cjs");

function isExcludedDirectory(name) {
  return DEFAULT_EXCLUDED_DIRS.has(String(name || "").toLowerCase());
}

function hasExcludedPathSegment(relativePath) {
  return String(relativePath || "")
    .split(/[\\/]+/)
    .some((segment) => isExcludedDirectory(segment));
}

function isLikelyBinary(buffer) {
  if (!buffer || buffer.length === 0) {
    return false;
  }
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  for (const byte of sample) {
    if (byte === 0) {
      return true;
    }
  }
  return false;
}

function getLineMatches(content, query, limit, options = {}) {
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matcher = new RegExp(options.regex ? query : options.wholeWord ? `\\b${escaped}\\b` : escaped, options.caseSensitive ? "g" : "gi");
  const lines = content.split(/\r?\n/);
  const matches = [];
  for (let index = 0; index < lines.length && matches.length < limit; index += 1) {
    const line = lines[index];
    matcher.lastIndex = 0;
    const match = matcher.exec(line);
    if (match) {
      const matchIndex = match.index;
      const start = Math.max(0, matchIndex - 80);
      const end = Math.min(line.length, matchIndex + match[0].length + 120);
      matches.push({
        lineNumber: index + 1,
        line: line.slice(start, end),
        matchStart: matchIndex - start,
        matchLength: match[0].length
      });
    }
  }
  return matches;
}

function normalizeQuery(query) {
  return String(query || "").trim();
}

function isOrderedSubsequence(candidate, query) {
  const normalizedCandidate = String(candidate || "").toLowerCase();
  const normalizedQuery = String(query || "").toLowerCase();
  let queryIndex = 0;

  for (let candidateIndex = 0; candidateIndex < normalizedCandidate.length && queryIndex < normalizedQuery.length; candidateIndex += 1) {
    if (normalizedCandidate[candidateIndex] === normalizedQuery[queryIndex]) {
      queryIndex += 1;
    }
  }

  return queryIndex === normalizedQuery.length;
}

function matchesFileQuery(candidate, query, options = {}) {
  const value = String(candidate || "");
  if (options.regex) return new RegExp(query, options.caseSensitive ? "" : "i").test(value);
  const haystack = options.caseSensitive ? value : value.toLowerCase();
  const needle = options.caseSensitive ? query : query.toLowerCase();
  if (options.wholeWord) return new RegExp(`\\b${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, options.caseSensitive ? "" : "i").test(value);
  return isOrderedSubsequence(haystack, needle);
}

module.exports = {
  isExcludedDirectory,
  hasExcludedPathSegment,
  isLikelyBinary,
  getLineMatches,
  normalizeQuery,
  isOrderedSubsequence,
  matchesFileQuery
};
