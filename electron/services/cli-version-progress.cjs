const OUTPUT_LIMIT = 6000;

function createUpdateProgress() {
  let stage = "checking";
  let output = "";
  function append(chunk) {
    output += String(chunk);
    if (output.length > OUTPUT_LIMIT) {
      const boundary = output.indexOf("\n", output.length - OUTPUT_LIMIT);
      output = boundary < 0 ? "" : output.slice(boundary + 1);
    }
  }
  function snapshot() {
    const clean = output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
      .replace(/\b(Authorization\s*:\s*Bearer\s+)\S+/gi, "$1[已隐藏]")
      .replace(/\b((?:Password|Token|Secret|API[_-]?Key)\s*(?:[:=]|\s)\s*)\S+/gi, "$1[已隐藏]")
      .replace(/(https?:\/\/)[^\s/@]+@/gi, "$1[已隐藏]@");
    return { stage, output: clean.trim() };
  }
  return {
    append,
    setStage(value) { stage = value; },
    snapshot
  };
}

module.exports = { createUpdateProgress };
