import {
  createElement,
  useEffect,
  useMemo,
  useRef,
  type ReactElement,
  type ReactNode,
} from 'react';
import { Markdown, type MarkdownReactOptions } from '@tanstack/markdown/react';
import type { MarkdownDocument } from '@tanstack/markdown';
import './safe-markdown.css';
import { parseSafeMarkdown, slugFromId } from './safe-markdown-core';

/**
 * Renders an untrusted model README as a safe article: frontmatter stripped,
 * raw HTML escaped to literal text, hash-route-safe heading ids, scheme-safe
 * links/images, and in-page anchors that scroll without changing the app's
 * hash route.
 */
export function SafeMarkdownArticle({
  markdown,
  repo,
  revision,
  testId,
}: {
  markdown: string;
  repo: string;
  revision: string;
  testId?: string;
}): ReactElement {
  const articleDoc = useMemo<MarkdownDocument>(
    () => parseSafeMarkdown(markdown, repo, revision),
    [markdown, repo, revision],
  );

  // In-page heading registry: full id AND bare slug -> element. The DOM id is
  // always the full `hf-<index>-<slug>`; README anchors typically use just the
  // slug (`#model-card`), so we index both.
  const headingRegistry = useMemo(() => new Map<string, HTMLElement>(), []);

  const options: MarkdownReactOptions = useMemo(
    () => ({
      headingAnchors: false,
      components: {
        ...Object.fromEntries(
          [1, 2, 3, 4, 5, 6].map((depth) => [
            'h' + depth,
            (() => {
              const Heading = function Heading(props: {
                id?: string;
                children: ReactNode;
              }): ReactElement {
                const ref = useRef<HTMLElement>(null);
                useEffect(() => {
                  const id = props.id;
                  const el = ref.current;
                  if (!id || !el) return;
                  headingRegistry.set(id, el);
                  const slug = slugFromId(id);
                  if (slug) headingRegistry.set(slug, el);
                  return () => {
                    headingRegistry.delete(id);
                    if (slug) headingRegistry.delete(slug);
                  };
                }, [props.id, props.children]);
                // `headingRegistry` is a stable, memoized Map (its identity never
                // changes), so mutating it is a no-op for re-renders — safe to
                // omit from deps per react-hooks/exhaustive-deps.
                return createElement(
                  `h${depth}`,
                  { id: props.id, ref },
                  props.children,
                );
              };
              return Heading;
            })(),
          ]),
        ),
        a: function SafeLink(props: {
          href?: string;
          title?: string;
          children: ReactNode;
        }): ReactElement {
          const { href, title, children } = props;
          if (!href || typeof href !== 'string') {
            return createElement('span', null, children);
          }
          if (href.startsWith('#')) {
            return createElement(
              'a',
              {
                href,
                title,
                className: 'safe-md-link',
                onClick: (event: React.MouseEvent<HTMLAnchorElement>) => {
                  event.preventDefault();
                  const target = href.slice(1);
                  const el =
                    window.document.getElementById(target) ??
                    headingRegistry.get(target);
                  el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                },
              },
              children,
            );
          }
          return createElement(
            'a',
            {
              href,
              title,
              target: '_blank',
              rel: 'noreferrer noopener',
              className: 'safe-md-link',
            },
            children,
          );
        },
        img: function SafeImg(props: {
          src?: string;
          alt?: string;
          title?: string;
        }): ReactElement | null {
          const { src, alt, title } = props;
          if (!src) {
            return alt
              ? createElement('span', { className: 'safe-md-alt' }, alt)
              : null;
          }
          return createElement('img', {
            src,
            alt,
            title,
            loading: 'lazy',
            className: 'safe-md-image',
          });
        },
      },
    }),
    [headingRegistry],
  );

  return (
    <article
      className="safe-markdown"
      data-testid={testId}
      aria-label={`Model README for ${repo}`}
    >
      <Markdown children={articleDoc} {...options} />
    </article>
  );
}
