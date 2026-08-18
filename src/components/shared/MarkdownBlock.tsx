import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";

export function MarkdownBlock({ content, className, externalLinks = false }: { content: string; className?: string; externalLinks?: boolean }) {
  if (!content || content === "-") {
    return <div className={className}>{content || "-"}</div>;
  }
  return (
    <div className={className}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={externalLinks ? {
          a: ({ href, children, ...props }) => (
            <a
              {...props}
              href={href}
              onClick={(event) => {
                event.preventDefault();
                if (href) void window.externalLinkApi.open(href);
              }}
            >
              {children}
            </a>
          )
        } : undefined}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
