const path = require("node:path");
const { isExcludedDirectory } = require("./search-matching.cjs");
const { throwIfCancelled } = require("./search-task.cjs");

async function walkProject({ fsApi, hostRoot, onFile, onDirectory, maxResults, maxVisitedEntries, task, includeIgnored = false }) {
  const queue = [{ hostPath: hostRoot, relativePath: "" }];
  let head = 0;
  let visitedEntries = 0;

  while (head < queue.length && visitedEntries < maxVisitedEntries) {
    throwIfCancelled(task);
    const current = queue[head];
    queue[head++] = undefined;
    let dirents;
    try {
      dirents = await fsApi.promises.readdir(current.hostPath, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const dirent of dirents) {
      throwIfCancelled(task);
      visitedEntries += 1;
      if (visitedEntries > maxVisitedEntries) break;

      const childRelativePath = current.relativePath
        ? path.join(current.relativePath, dirent.name)
        : dirent.name;
      const childHostPath = path.join(current.hostPath, dirent.name);

      if (dirent.isDirectory()) {
        if (!isExcludedDirectory(dirent.name) || (includeIgnored && ![".git", ".hg", ".svn"].includes(dirent.name))) {
          if (onDirectory) {
            await onDirectory({ hostPath: childHostPath, relativePath: childRelativePath, name: dirent.name });
            if (maxResults && maxResults()) {
              return;
            }
          }
          queue.push({ hostPath: childHostPath, relativePath: childRelativePath });
        }
        continue;
      }

      if (dirent.isFile()) {
        await onFile({ hostPath: childHostPath, relativePath: childRelativePath, name: dirent.name });
        if (maxResults && maxResults()) {
          return;
        }
      }
    }
  }
}

module.exports = {
  walkProject
};
