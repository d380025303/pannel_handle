import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";

export function MarkdownBlock({ content, className }: { content: string; className?: string }) {
  if (!content || content === "-") {
    return <div className={className}>{content || "-"}</div>;
  }
  return (
    <div className={className}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
        {content}
      </ReactMarkdown>
    </div>
  );
}
