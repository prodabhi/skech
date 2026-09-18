import Link from "next/link";
import { cn } from "@/lib/utils";

/**
 * The mark is a flat single-colour shape, so it is painted as a CSS mask filled
 * with `currentColor` rather than shipped as a coloured image. That keeps it
 * crisp at 24 to 28px and lets each placement choose its own weight, the nav gets
 * foreground, the footer gets subtle. It also keeps the mark from spending one
 * of the two green moments allowed per viewport.
 */
export function LogoMark({ className }: { className?: string }) {
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

/**
 * The mark and the wordmark, linking home. Used by the nav and the footer,
 * which had a byte-identical copy each, including the spelling, which is the
 * one thing on the page that must never drift.
 */
export function LogoLink({ className }: { className?: string }) {
  return (
    <Link
      aria-label="skech home"
      className={cn(
        "pressable flex items-center gap-2.5 text-foreground",
        className,
      )}
      href="/"
    >
      <LogoMark className="h-5 w-6" />
      {/* It is "skech", one t. Never "sketch". */}
      <span className="font-semibold text-[0.9375rem] tracking-[-0.025em]">
        skech
      </span>
    </Link>
  );
}
