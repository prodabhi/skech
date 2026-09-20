"use client";

import type { ComponentProps } from "react";
import { Drawer as Vaul } from "vaul";
import { cn } from "@/lib/utils";

/**
 * A sheet that comes up from the bottom, for phones.
 *
 * A menu that opens beside its trigger is fine on a desk and wrong on a
 * phone: the shapes menu opened to the right of a rail sitting at the left
 * edge, so half of it was off the screen and the page scrolled sideways to
 * reach it. A phone has one sensible direction for a panel, which is up from
 * the bottom, within reach of a thumb.
 *
 * Vaul, because dragging it closed is the gesture people already have.
 */

export const Drawer = Vaul.Root;
export const DrawerTrigger = Vaul.Trigger;
export const DrawerClose = Vaul.Close;

export function DrawerPopup({ children, className, ...props }: ComponentProps<typeof Vaul.Content>) {
  return (
    <Vaul.Portal>
      <Vaul.Overlay className="fixed inset-0 z-50 bg-black/32" />
      <Vaul.Content
        className={cn(
          "fixed inset-x-0 bottom-0 z-50 mt-24 flex max-h-[86vh] flex-col rounded-t-2xl border border-b-0 bg-popover outline-none",
          className,
        )}
        {...props}
      >
        {/* The handle says it can be dragged, which is the whole reason it is a drawer. */}
        <div aria-hidden="true" className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-muted-foreground/28" />
        <div
          className="min-h-0 flex-1 overflow-y-auto p-3"
          // The phone's home indicator sits over the last row otherwise.
          style={{ paddingBottom: "calc(0.75rem + env(safe-area-inset-bottom, 0px))" }}
        >
          {children}
        </div>
      </Vaul.Content>
    </Vaul.Portal>
  );
}

export function DrawerTitle({ className, ...props }: ComponentProps<typeof Vaul.Title>) {
  return <Vaul.Title className={cn("px-1 pb-2 font-medium text-sm", className)} {...props} />;
}

export function DrawerDescription({ className, ...props }: ComponentProps<typeof Vaul.Description>) {
  return <Vaul.Description className={cn("px-1 pb-3 text-muted-foreground text-xs leading-snug", className)} {...props} />;
}
