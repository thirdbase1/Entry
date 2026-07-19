'use client';

import type { Element, Root } from 'hast';
import { marked } from 'marked';
import { createContext, memo, useContext, useMemo, useRef } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { visit } from 'unist-util-visit';
import { cn } from '@/lib/utils';

function parseMarkdownIntoBlocks(markdown: string): string[] {
  const tokens = marked.lexer(markdown);
  return tokens.map(token => token.raw);
}

function remarkStripFootnoteRefs() {
  return (tree: Root) => {
    visit(tree, 'text', node => {
      node.value = node.value.replaceAll(/\[\^[^\]]*\]/g, '');
    });
  };
}

function extractLinks(footnoteSection: Element) {
  const links: { href: string; text: string; footnoteRef: string }[] = [];
  const ol = footnoteSection.children.find(
    n => n.type === 'element' && n.tagName === 'ol'
  ) as Element | undefined;
  if (!ol) return links;

  for (const li of ol.children) {
    if (li.type !== 'element' || li.tagName !== 'li') continue;
    const p = li.children.find(n => n.type === 'element' && n.tagName === 'p') as Element | undefined;
    if (!p) continue;
    const [, a, , aref] = p.children as [any, any, any, any];
    if (!a || !aref || !a.properties?.href || !aref.properties?.href) continue;
    const textNode = a.children.find((c: any) => c.type === 'text') as any;
    links.push({
      href: a.properties?.href as string,
      text: textNode?.value?.slice(0, -2) ?? a.properties?.href,
      footnoteRef: aref.properties.href,
    });
  }
  return links;
}

const InPreContext = createContext<boolean>(false);

function CustomCodeBlock({ className, children }: { className?: string; children: React.ReactNode }) {
  const inPre = useContext(InPreContext);
  if (inPre) {
    const lang = className?.match(/language-(\w+)/)?.[1] ?? 'text';
    return (
      <pre className="rounded-md bg-muted p-3 overflow-x-auto text-xs">
        <code data-lang={lang}>{children}</code>
      </pre>
    );
  }
  return <code className="bg-muted rounded px-1 py-0.5 text-xs">{children}</code>;
}

const footnoteComponents: Components = {
  sup({ node, children, ...rest }) {
    const id = (node?.properties?.id as string) ?? '';
    return id.startsWith('fnref-') ? (
      <sup {...rest} className="text-primary">
        {children}
      </sup>
    ) : (
      <sup {...rest}>{children}</sup>
    );
  },
  a({ node, children, ...rest }) {
    if (node?.properties?.dataFootnoteRef) {
      const href = node?.properties?.href as string;
      const scrollToRef = (e: React.MouseEvent) => {
        e.preventDefault();
        const markdownContainer = (e.target as HTMLElement).closest('[data-markdown-text]');
        const selector = `a[data-footnote-ref="#${node.properties!.id}"]`;
        const ref = markdownContainer?.querySelector(selector) as HTMLElement | null;
        if (ref) {
          ref.scrollIntoView({ behavior: 'smooth' });
          ref.classList.add('bg-primary/20', 'transition-colors');
          setTimeout(() => ref.classList.remove('bg-primary/20'), 1500);
        }
      };
      return (
        <a href={href} onClick={scrollToRef} className="text-primary underline">
          {children}
        </a>
      );
    }
    return (
      <a {...rest} className="text-primary underline">
        {children}
      </a>
    );
  },
  section({ node, ...rest }) {
    if (node?.properties?.dataFootnotes) {
      const links = extractLinks(node as Element);
      return (
        <ol className="mt-4 text-xs text-muted-foreground space-y-1">
          {links.map(({ href, text, footnoteRef }) => (
            <li key={footnoteRef} className="break-all">
              <a href={href} data-footnote-ref={footnoteRef} target="_blank" rel="noopener noreferrer" className="text-primary underline">
                {text}
              </a>
            </li>
          ))}
        </ol>
      );
    }
    return <section {...rest} />;
  },
  pre({ children }) {
    return <InPreContext.Provider value={true}>{children}</InPreContext.Provider>;
  },
  code({ className, children }) {
    return <CustomCodeBlock className={className}>{children}</CustomCodeBlock>;
  },
};

const MemoizedMarkdownBlock = memo(
  ({ content, split }: { content: string; split?: boolean }) => (
    <ReactMarkdown remarkPlugins={split ? [remarkGfm, remarkStripFootnoteRefs] : [remarkGfm]} components={footnoteComponents}>
      {content}
    </ReactMarkdown>
  ),
  (prev, next) => prev.content === next.content
);
MemoizedMarkdownBlock.displayName = 'MemoizedMarkdownBlock';

const MemoizedMarkdown = memo(({ content, split }: { content: string; split?: boolean }) => {
  // PERF FIX (2026-07-19, real streaming re-parse hotspot): during
  // streaming (`split` true) this re-ran marked.lexer() over the ENTIRE
  // accumulated message text on every streamed token -- O(n) lexing per
  // token, O(n²) over a whole message. For a long response (several KB of
  // markdown, normal for a coding agent) the lexer itself becomes the
  // main-thread cost that the rAF throttling upstream (use-throttled-
  // eve-agent.ts / useChat's `throttle: 50`) cannot help with, because it
  // happens INSIDE the render those throttles allow. Streamed tokens can
  // only ever change the TAIL block of the document -- every block before
  // it is already-terminated markdown that lexes identically every time.
  // So: keep the previous parse; if the new content merely extends the
  // old (the streaming case), only re-lex from the start of the previous
  // final block onward and reuse every earlier block by reference. The
  // per-block memo below then skips re-rendering all of them. Non-append
  // changes (edit, reset, non-split mode) fall through to a full parse,
  // identical to the old behavior.
  const prevRef = useRef<{ content: string; blocks: string[] } | null>(null);
  const blocks = useMemo(() => {
    if (!split) return [content];
    const prev = prevRef.current;
    let next: string[];
    if (prev && prev.blocks.length > 0 && content.startsWith(prev.content)) {
      const stable = prev.blocks.slice(0, -1);
      const stableLen = stable.reduce((n, b) => n + b.length, 0);
      const reparsed = parseMarkdownIntoBlocks(content.slice(stableLen));
      next = [...stable, ...reparsed];
    } else {
      next = parseMarkdownIntoBlocks(content);
    }
    prevRef.current = { content, blocks: next };
    return next;
  }, [content, split]);
  return (
    <>
      {blocks.map((block, index) => (
        <MemoizedMarkdownBlock content={block} key={`block_${index}`} split={split} />
      ))}
    </>
  );
});
MemoizedMarkdown.displayName = 'MemoizedMarkdown';

export function MarkdownText({
  text,
  loading = false,
  className,
  style,
}: {
  text: string;
  loading?: boolean;
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <span
      data-markdown-text
      className={cn(
        className,
        'prose prose-sm max-w-none text-foreground [&_*]:text-foreground',
        loading && 'after:content-["▍"] after:animate-pulse after:ml-0.5'
      )}
      style={style}
    >
      <MemoizedMarkdown content={text} split={loading} />
    </span>
  );
}
