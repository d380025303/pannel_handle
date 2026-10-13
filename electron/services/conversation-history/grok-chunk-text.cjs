// ACP chunks are fragments of one message: whitespace and block boundaries
// must survive until the complete message has been assembled.
function getGrokChunkText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter(item => item && ["input_text", "output_text", "text"].includes(item.type) && typeof item.text === "string")
      .map(item => item.text)
      .join("");
  }
  return typeof content?.text === "string" ? content.text : "";
}

module.exports = { getGrokChunkText };
