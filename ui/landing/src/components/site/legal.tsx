import Link from "next/link";
import type { ReactNode } from "react";
import { CONTACT_EMAIL, EFFECTIVE_DATE, mailto } from "@/lib/legal";
import { cn } from "@/lib/utils";
import { SiteFooter } from "./footer";
import { SiteNav } from "./nav";
import { Body, Heading, Kicker, Title } from "./type";

export type LegalSection = { id: string; title: string; body: ReactNode };

/**
 * The privacy policy, the terms and the deletion page: one column of prose
 * under the site's own nav and footer.
 *
 * Sections are data, so the contents list at the top and the headings below
 * are the same strings and cannot disagree. The column is held to about 70
 * characters, the width a page meant to be read end to end wants.
 */
export function LegalPage({
  title,
  lead,
  sections,
  contents = true,
  children,
}: {
  title: string;
  lead: ReactNode;
  sections: LegalSection[];
  /** The list of sections at the top. Off for a page short enough to see whole. */
  contents?: boolean;
  /** Anything between the header and the first section. */
  children?: ReactNode;
}) {
  return (
    <>
      <a
        className="sr-only focus:not-sr-only focus:fixed focus:top-4 focus:left-4 focus:z-60 focus:rounded-full focus:bg-primary focus:px-5 focus:py-2.5 focus:font-medium focus:text-primary-foreground"
        href="#main"
      >
        Skip to content
      </a>
      <SiteNav />
      <main className="container-x flex-1 px-4 pt-10 pb-20 sm:px-6 sm:pt-16 sm:pb-28 lg:px-8" id="main">
        <article className="mx-auto max-w-[44rem]">
          <header className="border-border border-b pb-8 sm:pb-10">
            <Kicker>Effective {EFFECTIVE_DATE}</Kicker>
            <Heading as="h1" className="mt-3">
              {title}
            </Heading>
            <Body className="mt-5 max-w-[60ch]">{lead}</Body>
          </header>

          {contents && (
            <nav aria-labelledby="contents-title" className="mt-8 rounded-2xl bg-surface px-5 py-5 sm:px-6">
              <Kicker as="h2" id="contents-title">
                On this page
              </Kicker>
              <ol className="mt-3 gap-x-8 text-[0.9375rem] leading-snug sm:columns-2">
                {sections.map((s, i) => (
                  <li className="mb-1.5 flex break-inside-avoid gap-2.5" key={s.id}>
                    <span aria-hidden="true" className="figures w-5 shrink-0 text-fg-subtle">
                      {i + 1}
                    </span>
                    <a className="text-fg-muted underline-offset-4 transition-colors duration-fast hover:text-foreground hover:underline" href={`#${s.id}`}>
                      {s.title}
                    </a>
                  </li>
                ))}
              </ol>
            </nav>
          )}

          {children}

          {sections.map((s) => (
            <section aria-labelledby={s.id} className="mt-12 scroll-mt-24 sm:mt-14" key={s.id}>
              <Title as="h2" id={s.id}>
                {s.title}
              </Title>
              <div className="mt-3 space-y-4">{s.body}</div>
            </section>
          ))}
        </article>
      </main>
      <SiteFooter />
    </>
  );
}

/** A paragraph of the policy. */
export function P({ children, className }: { children: ReactNode; className?: string }) {
  return <Body className={cn("max-w-[68ch]", className)}>{children}</Body>;
}

/** A plain list, one point a line. */
export function List({ children }: { children: ReactNode }) {
  return (
    <ul className="max-w-[68ch] list-disc space-y-2 pl-5 text-body text-fg-muted marker:text-fg-subtle">
      {children}
    </ul>
  );
}

/** A term the reader should not miss, in the ink colour. */
export function Em({ children }: { children: ReactNode }) {
  return <strong className="font-semibold text-foreground">{children}</strong>;
}

/** A link inside the prose: a page of this site through Next, anything else as itself. */
export function A({ href, children }: { href: string; children: ReactNode }) {
  const className = "text-brand underline decoration-brand/40 underline-offset-4 transition-colors duration-fast hover:decoration-brand";
  if (href.startsWith("/")) {
    return (
      <Link className={className} href={href}>
        {children}
      </Link>
    );
  }
  const external = /^https?:/.test(href);
  return (
    <a className={className} href={href} {...(external ? { rel: "noopener noreferrer", target: "_blank" } : {})}>
      {children}
    </a>
  );
}

/** The contact address, as a link. */
export function Contact({ subject }: { subject?: string }) {
  return <A href={mailto(subject)}>{CONTACT_EMAIL}</A>;
}
