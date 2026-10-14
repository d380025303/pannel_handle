async function sourceSignature(fsApi, files) {
  const values = await Promise.all(files.map(async file => {
    try {
      const stat = await fsApi.promises.stat(file);
      return [file, stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs];
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      return [file, null];
    }
  }));
  return JSON.stringify(values);
}
module.exports = { sourceSignature };
