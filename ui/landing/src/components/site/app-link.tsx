import { cn } from "@/lib/utils";

/** The app, live: where every call to action on the page goes. */
export const APP_URL = process.env.NEXT_PUBLIC_APP_URL?.trim() || "https://app.skech.trade";

/** The page's one call to action, one string everywhere: Draw a trade. */
export function DrawATrade({ className, children }: { className?: string; children?: React.ReactNode }) {
  return (
    <a
      className={cn(
        "pressable inline-flex items-center justify-center gap-2.5 whitespace-nowrap rounded-full bg-primary font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-brand",
        className,
      )}
      href={APP_URL}
    >
      {children}
      Draw a trade
    </a>
  );
}
