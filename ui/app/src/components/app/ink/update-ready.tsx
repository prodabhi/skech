"use client";

import Image from "next/image";
import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { track } from "@/lib/analytics";
import { useUpdate } from "@/lib/update";
import feedback from "./drawing-feedback.module.css";

/**
 * A newer skech is live. With nothing in play it has already reloaded itself (see useUpdate); with ink in
 * play it asks, in the Home Screen bar's own shape, so a line is never lost to an update.
 */
export function UpdateReady({ busy }: { busy: boolean }) {
  const { ready, update } = useUpdate(busy);
  useEffect(() => {
    if (ready) track("update_shown", { busy });
    // Only when it first shows.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);
  if (!ready) return null;
  return (
    <div aria-label="A new version of skech is ready" className={feedback.updateBar} role="status">
      <div aria-hidden="true" className={feedback.homeTile}>
        <div className={feedback.homePen}>
          <Image alt="" height={459} src="/assets/pen-mascot.png" width={360} />
        </div>
      </div>
      <div className={feedback.homeText}>
        <strong>A new skech is ready</strong>
        <span>{busy ? "Update when this round is over" : "Takes a second"}</span>
      </div>
      <Button className="h-9 shrink-0 rounded-full px-4 font-semibold text-sm sm:h-9" onClick={update} size="sm">
        Update
      </Button>
    </div>
  );
}
