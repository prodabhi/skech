"use client";

import { ActivityIcon, ArrowDownLeftIcon, ArrowUpRightIcon, CheckIcon, ChevronRightIcon, CircleQuestionMarkIcon, CoinsIcon, CopyIcon, LogOutIcon, SlidersHorizontalIcon, SquarePlusIcon } from "lucide-react";
import type { ComponentProps } from "react";
import { Button } from "@/components/ui/button";
import { Menu, MenuGroup, MenuGroupLabel, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { PRIVATE_TEXT } from "@/lib/analytics";
import { shortAddress } from "@/lib/market";
import { money, skt } from "@/lib/money";
import { cn } from "@/lib/utils";
import { useCopy } from "./copy";
import { AccountAvatar } from "./player-avatar";

type Face = ComponentProps<typeof AccountAvatar>["profile"];

export type AccountMenuProps = {
  /** Null for the moment between signing in and the wallet being made. */
  address: string | null;
  name: string;
  profile?: Face;
  /** The balance, playing for real; null otherwise, and there is no money group. */
  balance: number | null;
  /** The player's SKT (e6) and what it has earned (USDC), playing for real; null otherwise. */
  skt?: { balance: number; claimable: number } | null;
  claiming?: boolean;
  onClaim?: () => void;
  /** Whether the relayer counts transactions: only then is there a list of them. */
  counted: boolean;
  /** A phone's browser, not yet on the Home Screen. */
  installable: boolean;
  /** Opens the community profile; without a community the header is not a button. */
  onProfile?: () => void;
  onDeposit: () => void;
  onWithdraw: () => void;
  onTransactions: () => void;
  onSettings: () => void;
  onHelp: () => void;
  onHomeScreen: () => void;
  onSignOut: () => void;
};

const row = "min-h-11 gap-3 rounded-xl px-2.5 sm:min-h-11";

/**
 * The account, as a finance app's menu: who you are (a way to your profile), your money (the balance, in, out and
 * the transactions), the app (Settings, How it works, the Home Screen), and signing out, alone at the bottom. The
 * phone's (solana-mobile app-bar.tsx) is the same, with light or dark in place of the Home Screen.
 */
export function AccountMenu(p: AccountMenuProps) {
  return (
    <Menu>
      <MenuTrigger render={<Button aria-label="Your account" className="size-11 rounded-full border-0 bg-secondary p-0 sm:size-11" size="icon" variant="outline" />}>
        <AccountAvatar address={p.address} className="size-9" profile={p.profile} />
      </MenuTrigger>
      <AccountMenuPopup {...p} />
    </Menu>
  );
}

export function AccountMenuPopup(p: AccountMenuProps) {
  return (
    <MenuPopup align="end" className="w-[288px] p-1.5">
      {/* The whole header opens the profile; the address over it copies, and is its own item for the keyboard. */}
      <div className="relative flex min-h-16 items-center gap-3 px-2.5 py-2.5">
        {p.onProfile ? <MenuItem aria-label="Your profile" className="absolute inset-0 min-h-0 rounded-xl p-0 sm:min-h-0" onClick={p.onProfile} /> : null}
        <AccountAvatar address={p.address} className="pointer-events-none relative size-11 shrink-0" profile={p.profile} />
        <div className="pointer-events-none relative flex min-w-0 flex-1 flex-col items-start gap-0.5">
          <p className={cn("max-w-full truncate font-semibold text-[15px] leading-tight", PRIVATE_TEXT)}>{p.name}</p>
          {p.address ? <CopyAddressItem address={p.address} /> : null}
        </div>
        {p.onProfile ? <ChevronRightIcon aria-hidden="true" className="pointer-events-none relative size-4 shrink-0 text-muted-foreground" /> : null}
      </div>
      {p.balance !== null ? (
        <>
          <MenuSeparator className="mx-1" />
          <MenuGroup>
            <MenuGroupLabel className="flex flex-col gap-0.5 px-2.5 pt-2 pb-1.5">
              <span className="font-normal text-[13px] text-muted-foreground">Balance</span>
              <span className="figures font-semibold text-2xl text-foreground leading-tight tracking-tight">{money(p.balance)}</span>
            </MenuGroupLabel>
            <MenuItem className={row} onClick={p.onDeposit}>
              <ArrowDownLeftIcon />
              Deposit
            </MenuItem>
            <MenuItem className={row} disabled={p.balance <= 0} onClick={p.onWithdraw}>
              <ArrowUpRightIcon />
              Withdraw
            </MenuItem>
            {p.skt ? (
              <MenuItem className={row} disabled={p.skt.claimable < 0.01 || p.claiming} onClick={p.onClaim}>
                <CoinsIcon />
                <span className="flex flex-1 items-baseline gap-1.5">
                  SKT <span className="figures text-muted-foreground">{skt(p.skt.balance)}</span>
                </span>
                <span className="figures text-[13px] text-muted-foreground">{p.claiming ? "Claiming…" : `Claim ${money(p.skt.claimable)}`}</span>
              </MenuItem>
            ) : null}
            {/* Only where the relayer counts them: an empty sheet of dashes says nothing. */}
            {p.counted ? (
              <MenuItem className={row} onClick={p.onTransactions}>
                <ActivityIcon />
                Transactions
              </MenuItem>
            ) : null}
          </MenuGroup>
        </>
      ) : null}
      <MenuSeparator className="mx-1" />
      <MenuItem className={row} onClick={p.onSettings}>
        <SlidersHorizontalIcon />
        Settings
      </MenuItem>
      <MenuItem className={row} onClick={p.onHelp}>
        <CircleQuestionMarkIcon />
        How it works
      </MenuItem>
      {p.installable ? (
        <MenuItem className={row} onClick={p.onHomeScreen}>
          <SquarePlusIcon />
          Add to Home Screen
        </MenuItem>
      ) : null}
      <MenuSeparator className="mx-1" />
      <MenuItem className={row} onClick={p.onSignOut} variant="destructive">
        <LogOutIcon />
        Sign out
      </MenuItem>
    </MenuPopup>
  );
}

/** The short address under the name: copies, and stays open to say so. A finger-sized target around small type. */
function CopyAddressItem({ address }: { address: string }) {
  const { copied, copy } = useCopy(address);
  return (
    <MenuItem
      aria-label={copied ? "Address copied" : `Copy address ${address}`}
      className="pointer-events-auto relative -mx-1 min-h-0 gap-1 rounded-md px-1 py-0.5 text-[13px] text-muted-foreground after:absolute after:-inset-x-2 after:-top-1.5 after:-bottom-4 after:content-[''] data-highlighted:text-foreground sm:min-h-0 sm:text-[13px]"
      closeOnClick={false}
      onClick={() => void copy()}
    >
      <span className="figures">{shortAddress(address)}</span>
      {copied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
    </MenuItem>
  );
}
