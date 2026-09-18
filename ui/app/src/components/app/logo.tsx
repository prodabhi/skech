import { cn } from "@/lib/utils";

/** The mark is a flat shape, painted as a mask in currentColor. */
function LogoMark({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn("block shrink-0 bg-current", className)}
      style={{
        maskImage: "url(/assets/logo-mark-alpha.webp)",
        maskRepeat: "no-repeat",
        maskPosition: "center",
        maskSize: "contain",
        WebkitMaskImage: "url(/assets/logo-mark-alpha.webp)",
        WebkitMaskRepeat: "no-repeat",
        WebkitMaskPosition: "center",
        WebkitMaskSize: "contain",
      }}
    />
  );
}

/** "skech", one t. Never "sketch". */
export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn("flex items-center gap-2 text-foreground", className)}>
      <LogoMark className="h-6 w-[30px]" />
      <span className="font-bold text-xl tracking-[-0.03em]">skech</span>
    </span>
  );
}
