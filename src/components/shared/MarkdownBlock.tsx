import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";

export function MarkdownBlock({ content, className, externalLinks = false, onLinkClick }: { content: string; className?: string; externalLinks?: boolean; onLinkClick?: (href: string) => void }) {
  if (!content || content === "-") {
    return <div className={className}>{content || "-"}</div>;
  }
  return (
    <div className={className}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        urlTransform={(url) => /^(?:https?:\/\/|file:\/\/|mailto:)/i.test(url) || !/^[a-z][a-z\d+.-]*:/i.test(url) || /^[a-z]:[\\/]/i.test(url) ? url : ""}
        components={externalLinks || onLinkClick ? {
          a: ({ href, children, ...props }) => (
            <a
              {...props}
              href={href}
              onClick={(event) => {
                event.preventDefault();
                if (!href) return;
                if (onLinkClick) {
                  onLinkClick(href);
                } else {
                  void window.externalLinkApi.open(href);
                }
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
