import { memo, useId, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";

type MarkdownBlockProps = {
  content: string;
  className?: string;
  externalLinks?: boolean;
  onLinkClick?: (href: string) => void;
  linkActions?: boolean;
};

function MarkdownLink({ href, children, onLinkClick, linkActions, ...props }: {
  href?: string;
  children: React.ReactNode;
  onLinkClick?: (href: string) => void;
  linkActions: boolean;
} & React.AnchorHTMLAttributes<HTMLAnchorElement>) {
  const addressId = useId();
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [copyStatus, setCopyStatus] = useState("");
  const showActions = linkActions && Boolean(href) && (hovered || focused);
  const anchor = <a {...props} href={href} aria-describedby={showActions ? addressId : undefined} onClick={(event) => {
    event.preventDefault();
    if (!href) return;
    if (onLinkClick) onLinkClick(href);
    else void window.externalLinkApi.open(href);
  }}>{children}</a>;

  if (!linkActions || !href) return anchor;

  async function copyAddress() {
    try {
      setCopyStatus(await window.clipboardApi.writeText(href!) ? "已复制" : "复制失败");
    } catch {
      setCopyStatus("复制失败");
    }
  }

  return <span className="markdown-link-actions" onMouseEnter={() => { setHovered(true); setCopyStatus(""); }}
    onMouseLeave={() => setHovered(false)} onFocus={() => setFocused(true)}
    onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false); }}>
    {anchor}
    {showActions && <span className="markdown-link-actions-popup">
      <span id={addressId} className="markdown-link-actions-address">{href}</span>
      <button type="button" aria-label="复制链接地址" onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        void copyAddress();
      }}>复制地址</button>
      {copyStatus && <span role="status">{copyStatus}</span>}
    </span>}
  </span>;
}

export const MarkdownBlock = memo(function MarkdownBlock({ content, className, externalLinks = false, onLinkClick, linkActions = false }: MarkdownBlockProps) {
  if (!content || content === "-") {
    return <div className={className}>{content || "-"}</div>;
  }
  return (
    <div className={className}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        urlTransform={(url) => /^(?:https?:\/\/|file:\/\/|mailto:)/i.test(url) || !/^[a-z][a-z\d+.-]*:/i.test(url) || /^[a-z]:[\\/]/i.test(url) ? url : ""}
        components={externalLinks || onLinkClick || linkActions ? {
          a: ({ href, children, ...props }) => <MarkdownLink {...props} href={href} onLinkClick={onLinkClick} linkActions={linkActions}>{children}</MarkdownLink>
        } : undefined}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
});
