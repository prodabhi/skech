"use client";

import { Button } from "@/components/ui/button";
import { track } from "@/lib/analytics";
import { cn } from "@/lib/utils";
import { useSignIn } from "./auth";

/**
 * Our button, Privy's panel.
 *
 * The modal is theirs and stays theirs: the one-time codes and the recovery
 * are the parts that lock someone out of their money if they are got wrong.
 * The trigger is ours, so the corner of the app looks like the rest of it.
 */
export function SignInButton({ className }: { className?: string }) {
  const signIn = useSignIn();
  return (
    /* Matched to the toggle beside it on a phone, where it was forty
       against forty-four and the two sat on different centre lines in the
       same bar. The small size is kept for the desk, unchanged. */
    <Button className={cn("h-11 rounded-full px-[18px] font-semibold text-base sm:h-11 sm:px-[18px]", className)} onClick={() => { track("sign_in_opened", { from: "app_bar" }); signIn(); }} size="sm">
      Sign in
    </Button>
  );
}
