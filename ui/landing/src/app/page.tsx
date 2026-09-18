import { Cta } from "@/components/site/cta";
import { Features } from "@/components/site/features";
import { Faq } from "@/components/site/faq";
import { SiteFooter } from "@/components/site/footer";
import { Hero } from "@/components/site/hero";
import { HowItWorks } from "@/components/site/how-it-works";
import { RevealBand } from "@/components/site/reveal-band";
import { WorkedExample } from "@/components/site/worked-example";
import { SiteNav } from "@/components/site/nav";
import { StoryStack } from "@/components/site/story-stack";

export default function HomePage() {
  return (
    <>
      <a
        className="sr-only focus:not-sr-only focus:fixed focus:top-4 focus:left-4 focus:z-60 focus:rounded-full focus:bg-primary focus:px-5 focus:py-2.5 focus:font-medium focus:text-primary-foreground"
        href="#main"
      >
        Skip to content
      </a>
      <SiteNav />
      <main id="main">
        <Hero />
        <StoryStack>
          <HowItWorks />
          <WorkedExample />
        </StoryStack>
        <RevealBand />
        <Features />
        <Faq />
        <Cta />
      </main>
      <SiteFooter />
    </>
  );
}
