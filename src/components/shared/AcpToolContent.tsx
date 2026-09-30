type Value = Record<string, unknown>;
const record = (value: unknown): Value => value && typeof value === "object" && !Array.isArray(value) ? value as Value : {};
const text = (value: unknown) => typeof value === "string" ? value : "";

export function AcpToolContent({ content }: { content: unknown[] }) {
  return <div className="acp-tool-content">{content.map((entry, index) => {
    const block = record(entry);
    if (block.type === "diff") return <details key={index}>
      <summary>{text(block.path) || "文件变更"}</summary>
      <div><strong>修改前</strong><pre style={{ borderLeft: "3px solid #d14343", paddingLeft: 8 }}>{block.oldText == null ? "（新文件）" : text(block.oldText)}</pre></div>
      <div><strong>修改后</strong><pre style={{ borderLeft: "3px solid #299653", paddingLeft: 8 }}>{text(block.newText)}</pre></div>
    </details>;
    if (block.type === "terminal") return <p key={index}>终端：{text(block.terminalId)}</p>;
    const value = block.type === "content" ? record(block.content) : block;
    if (value.type === "text") return <pre key={index}>{text(value.text)}</pre>;
    if (value.type === "image" && /^image\/(png|jpeg|gif|webp)$/.test(text(value.mimeType)) && typeof value.data === "string")
      return <img key={index} alt="工具返回的图片" loading="lazy" style={{ maxWidth: "100%", maxHeight: 480, objectFit: "contain" }} src={`data:${value.mimeType};base64,${value.data}`} />;
    if (value.type === "resource_link" || value.type === "resource") {
      const resource = value.type === "resource" ? record(value.resource) : value;
      return <div key={index}><p>{text(value.name) || text(resource.uri) || "资源"}</p>
        {Boolean(value.name) && <p>{text(resource.uri)}</p>}
        {Boolean(resource.mimeType) && <small>{text(resource.mimeType)}{typeof value.size === "number" ? ` · ${value.size} 字节` : ""}</small>}
        {typeof resource.text === "string" && <pre>{resource.text}</pre>}
        {typeof resource.blob === "string" && <p>二进制资源</p>}
      </div>;
    }
    return <pre key={index}>{JSON.stringify(entry, null, 2)}</pre>;
  })}</div>;
}
