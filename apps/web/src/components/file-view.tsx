'use client';

import { MarkdownView } from './markdown';

/** Markdown files render; everything else (yaml, csv, json, txt) shows as text. */
export function FileContent({
  path,
  content,
  onWikiLink,
}: {
  path: string;
  content: string;
  onWikiLink?: (target: string) => void;
}) {
  if (/\.md$/i.test(path)) return <MarkdownView text={content} onWikiLink={onWikiLink} />;
  return (
    <pre className="num overflow-x-auto whitespace-pre-wrap break-words rounded-md bg-bg p-3 text-[12px] leading-relaxed text-ink-2">
      {content}
    </pre>
  );
}

/** Resolve a `[[target]]` wiki link against a file list (wiki/ pages, .md optional). */
export function resolveWikiLink(target: string, paths: string[]): string | undefined {
  const t = target.replace(/^\/+/, '');
  const candidates = [t, `${t}.md`, `wiki/${t}`, `wiki/${t}.md`];
  return candidates.find(c => paths.includes(c));
}
