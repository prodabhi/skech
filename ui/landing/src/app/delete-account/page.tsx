// Draft for legal review before launch.
import type { Metadata } from "next";
import { A, Contact, Em, LegalPage, type LegalSection, List, P } from "@/components/site/legal";
import { CONTACT_EMAIL, DELETE_DAYS, DELETE_SUBJECT, mailto } from "@/lib/legal";

const DESCRIPTION = "How to delete your skech account, on the web or Android, and what deleting it removes.";

export const metadata: Metadata = {
  title: "Delete your account | skech",
  description: DESCRIPTION,
  alternates: { canonical: "/delete-account" },
  openGraph: { title: "Delete your account | skech", description: DESCRIPTION, url: "/delete-account", siteName: "skech", type: "website" },
};

const BODY = "Wallet address: \nI signed in with (email or phone): \n";

const SECTIONS: LegalSection[] = [
  {
    id: "withdraw",
    title: "Step 1. Withdraw your balance",
    body: (
      <>
        <P>Open skech, sign in, and withdraw everything to a wallet you control.</P>
        <P>
          <Em>Do this first.</Em> Once your sign-in is deleted, you may no longer be able to reach the wallet that holds
          your balance, and we cannot move it for you.
        </P>
      </>
    ),
  },
  {
    id: "email",
    title: "Step 2. Email us",
    body: (
      <>
        <List>
          <li>
            Send it to <Contact subject={DELETE_SUBJECT} />.
          </li>
          <li>Send it from the email address you signed in with. If you signed in by phone, give that number.</li>
          <li>
            Use the subject <Em>&ldquo;{DELETE_SUBJECT}&rdquo;</Em>.
          </li>
          <li>Include your wallet address. You can copy it from the deposit screen in the app.</li>
        </List>
        <div>
          <a
            className="pressable inline-flex min-h-11 items-center justify-center rounded-full bg-primary px-5 font-medium text-[0.9375rem] text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-brand"
            href={mailto(DELETE_SUBJECT, BODY)}
          >
            Email a deletion request
          </a>
        </div>
      </>
    ),
  },
  {
    id: "next",
    title: "What happens next",
    body: (
      <List>
        <li>We may ask you to confirm the request comes from you.</li>
        <li>
          We delete your account and confirm by email <Em>within {DELETE_DAYS} days</Em>.
        </li>
        <li>After that, signing in again with the same email or phone starts a new, empty account.</li>
      </List>
    ),
  },
  {
    id: "removed",
    title: "What deletion removes",
    body: (
      <List>
        <li>Your sign-in, and the email address or phone number it uses.</li>
        <li>Your account with Privy, our sign-in provider, including the embedded wallet it made for you.</li>
        <li>The records our servers keep tied to your wallet address.</li>
        <li>Your web analytics and error reports in PostHog and Sentry, tied to your wallet address.</li>
      </List>
    ),
  },
  {
    id: "kept",
    title: "What it cannot remove",
    body: (
      <>
        <List>
          <li>
            <Em>Your history on the blockchain.</Em> Your deposits, withdrawals, every piece you placed and every payout
            are public and permanent. No one can delete them.
          </li>
          <li>Anything the law requires us to keep, for as long as it requires. We delete it after that.</li>
          <li>
            A wallet of your own, such as Phantom or Solflare. It is yours, not ours. Removing skech does not affect it.
          </li>
        </List>
        <P>
          On Android, uninstalling the app removes the drawing key and settings stored on your phone. On the web, clearing
          the site&rsquo;s data in your browser does the same.
        </P>
      </>
    ),
  },
  {
    id: "questions",
    title: "Questions",
    body: (
      <P>
        Write to <A href={mailto()}>{CONTACT_EMAIL}</A>. What we collect, and how long we keep it, is in our{" "}
        <A href="/privacy">privacy policy</A>.
      </P>
    ),
  },
];

export default function DeleteAccountPage() {
  return (
    <LegalPage
      contents={false}
      lead={
        <>
          How to delete your skech account, for both the web app and the Android app. It takes
          two steps.
        </>
      }
      sections={SECTIONS}
      title="Delete your account"
    />
  );
}
