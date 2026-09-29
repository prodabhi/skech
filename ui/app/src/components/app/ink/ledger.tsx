"use client";

import { useSyncExternalStore } from "react";
import { cents, money } from "@/lib/money";
import { cn } from "@/lib/utils";
import feedback from "./drawing-feedback.module.css";

/*
  What just moved the balance, under it: a stake as a light minus, a win as a green plus, money back as a
  light plus. The newest sits right under the balance; older ones step down, lighter and smaller, and fade.

  Pieces of one stroke go in every 150 ms, so changes of the same kind that land close together merge into
  one line that keeps counting, rather than a waterfall of dimes.
*/

export type Change = { id: number; amount: number; kind: "stake" | "win" | "back"; at: number };

const SHOW = 3;
const LIFE_MS = 4200;
const MERGE_MS = 900;

let rows: Change[] = [];
let next = 1;
const listeners = new Set<() => void>();
const emit = () => {
  for (const l of listeners) l();
};

function prune() {
  const now = performance.now();
  const kept = rows.filter((r) => now - r.at < LIFE_MS);
  if (kept.length !== rows.length) {
    rows = kept;
    emit();
  }
  if (rows.length) setTimeout(prune, 250);
}

/** Record a move of the balance. Negative is a stake. Zero is ignored. */
export function addChange(amount: number, kind: Change["kind"]) {
  if (!amount || !Number.isFinite(amount)) return;
  const now = performance.now();
  const top = rows[0];
  const idle = rows.length === 0;
  if (top && top.kind === kind && now - top.at < MERGE_MS) rows = [{ ...top, amount: cents(top.amount + amount), at: now }, ...rows.slice(1)];
  else rows = [{ id: next++, amount: cents(amount), kind, at: now }, ...rows].slice(0, SHOW + 1);
  emit();
  if (idle) setTimeout(prune, 250);
}

const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => void listeners.delete(fn);
};
const EMPTY: Change[] = [];
const useChanges = () => useSyncExternalStore(subscribe, () => rows, () => EMPTY);

export function Ledger() {
  const changes = useChanges();
  return (
    <span aria-hidden="true" className={feedback.ledger}>
      {changes.slice(0, SHOW).map((c, i) => (
        <span
          className={cn(feedback.ledgerRow, "figures", c.kind === "win" ? "text-success-foreground" : "text-muted-foreground")}
          key={c.id}
          style={{ transform: `translateY(${i * 17}px) scale(${1 - i * 0.08})`, opacity: [1, 0.55, 0.28][i] }}
        >
          {/* The inner span carries the entrance and the fade, the outer one its place in the stack. */}
          <span className={feedback.ledgerLife} key={`${c.id}:${c.amount}`}>
            {c.amount > 0 ? "+" : "−"}
            {money(c.amount)}
          </span>
        </span>
      ))}
    </span>
  );
}
