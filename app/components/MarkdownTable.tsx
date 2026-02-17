// Markdown table renderer with custom styling for football data
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { extractText, detectTableType, getCellClassName } from "../lib/utils";

interface MarkdownTableProps {
  content: string;
}

export const MarkdownTable = ({ content }: MarkdownTableProps) => {
  return (
    <div className="prose-v11 mt-2">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          table: ({ children, node }) => {
            const thead = (node as { children?: unknown[] })?.children?.[0];
            const headerText = extractText(thead);
            const tableType = detectTableType(headerText);

            return (
              <div className={`table-wrap ${tableType}`}>
                <table>{children}</table>
              </div>
            );
          },
          td: ({ children }) => {
            const text = String(children).trim();
            const className = getCellClassName(text);
            return <td className={className}>{children}</td>;
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
};
