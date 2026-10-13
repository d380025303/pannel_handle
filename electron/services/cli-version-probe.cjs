function parseCliProbe(output, { marker, keys, nonempty = ["commandPath", "resolvedPath"], incompleteMessage }) {
  const lines = String(output).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "").split(/\r?\n/).map(line => line.trim());
  const begin = lines.indexOf(`__PANNEL_${marker}_PROBE_BEGIN__`);
  const end = lines.indexOf(`__PANNEL_${marker}_PROBE_END__`, begin + 1);
  const versionBegin = lines.indexOf(`__PANNEL_${marker}_VERSION_BEGIN__`, begin + 1);
  const versionEnd = lines.indexOf(`__PANNEL_${marker}_VERSION_END__`, versionBegin + 1);
  const incomplete = () => { throw new Error(incompleteMessage); };
  if (begin < 0 || end < 0 || versionBegin !== begin + 1 || versionEnd <= versionBegin || versionEnd >= end) incomplete();
  const fields = new Map();
  for (const line of lines.slice(versionEnd + 1, end)) {
    const separator = line.indexOf("=");
    if (separator < 0 || fields.has(line.slice(0, separator))) incomplete();
    fields.set(line.slice(0, separator), line.slice(separator + 1));
  }
  if (keys.some(key => !fields.has(key)) || nonempty.some(key => !fields.get(key))) incomplete();
  return [lines.slice(versionBegin + 1, versionEnd).join("\n"), ...keys.map(key => fields.get(key))];
}

module.exports = { parseCliProbe };
