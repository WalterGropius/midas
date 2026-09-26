'use client';

import Markdown, { defaultUrlTransform } from 'react-markdown';

const WIKI_PREFIX = '#wiki/';

/**
 * Renders agent-written markdown safely: raw HTML is dropped (skipHtml),
 * URLs go through react-markdown's default sanitizer, links open in a new tab.
 * `[[page]]` wiki links become in-app links handled by `onWikiLink`.
 */
export function MarkdownView({ text, onWikiLink }: { text: string; onWikiLink?: (target: string) => void }) {
  const src = onWikiLink ? text.replace(/\[\[([^\]\n|]+)(?:\|([^\]\n]+))?\]\]/g, (_m, target: string, label?: string) => `[${label ?? target}](${WIKI_PREFIX}${encodeURIComponent(target.trim())})`) : text;
  return (
    <div className="md">
      <Markdown
        skipHtml
        urlTransform={url => (url.startsWith(WIKI_PREFIX) ? url : defaultUrlTransform(url))}
        components={{
          a: ({ href, children }) => {
            if (href?.startsWith(WIKI_PREFIX) && onWikiLink) {
              const target = decodeURIComponent(href.slice(WIKI_PREFIX.length));
              return (
                <a
                  href={href}
                  onClick={e => {
                    e.preventDefault();
                    onWikiLink(target);
                  }}
                >
                  {children}
                </a>
              );
            }
            return (
              <a href={href} target="_blank" rel="noopener noreferrer nofollow">
                {children}
              </a>
            );
          },
          img: ({ alt }) => <span className="text-muted">[image: {alt || 'untitled'}]</span>,
        }}
      >
        {src}
      </Markdown>
    </div>
  );
}
