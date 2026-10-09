// Draft for legal review before launch.
import type { Metadata } from "next";
import { A, Contact, Em, LegalPage, type LegalSection, List, P } from "@/components/site/legal";

const DESCRIPTION = "What skech collects, why, who else sees it, and how to have it deleted.";

export const metadata: Metadata = {
  title: "Privacy policy | skech",
  description: DESCRIPTION,
  alternates: { canonical: "/privacy" },
  openGraph: { title: "Privacy policy | skech", description: DESCRIPTION, url: "/privacy", siteName: "skech", type: "website" },
};

const SECTIONS: LegalSection[] = [
  {
    id: "who-we-are",
    title: "Who we are",
    body: (
      <>
        <P>
          &ldquo;We&rdquo; and &ldquo;us&rdquo; in this policy mean <Em>skech</Em>, the team that runs this website, the
          web app and the Android app.
        </P>
        <P>
          skech is a Bitcoin price prediction game. You draw where you think Bitcoin&rsquo;s price goes over the next few
          seconds. The parts of your line the price passes through pay a set multiple. The parts it misses, you lose what
          you put on them.
        </P>
        <P>
          This policy covers this website (skech.trade), the web app (app.skech.trade) and the skech Android app.
        </P>
      </>
    ),
  },
  {
    id: "from-you",
    title: "What you give us",
    body: (
      <List>
        <li>
          <Em>Your email address or phone number</Em>, if you sign in with Privy. On the web you can also sign in with a
          Google or Apple account. Privy holds these details. We can see them in Privy&rsquo;s dashboard. They are not
          sent to our own servers.
        </li>
        <li>
          <Em>What you write to us</Em>, and the address or account you write from, if you email us or message us on
          Telegram.
        </li>
        <li>
          <Em>Your email address</Em>, if you joined our waitlist.
        </li>
      </List>
    ),
  },
  {
    id: "from-the-chain",
    title: "What your wallet and the blockchain show",
    body: (
      <>
        <List>
          <li>
            <Em>Your wallet address.</Em> It is how skech knows you. Our servers, PostHog and Sentry know you by it,
            never by your email or phone number.
          </li>
          <li>
            <Em>Your balance</Em>, and every deposit, withdrawal and payout.
          </li>
          <li>
            <Em>Every piece of every line you draw</Em>: where it sits on the chart, what you put on it, and how it
            settled.
          </li>
        </List>
        <P>
          All of this is recorded on a public blockchain, Solana. Anyone can
          read it, and it stays there for good. We cannot change it or delete it.
        </P>
        <P>
          Our servers also keep a running count for each address: how many transactions and pieces it has, and its last
          few transactions, so the app can show your history.
        </P>
      </>
    ),
  },
  {
    id: "from-your-device",
    title: "What your device sends",
    body: (
      <>
        <List>
          <li>
            <Em>Your IP address</Em>, when the app connects to our servers. We use it only to limit how many connections
            and requests one address can make. By design it is kept in memory and not written to disk. Our hosting
            providers&rsquo; logs may hold it for a short time.
          </li>
          <li>
            <Em>A drawing key</Em>, made and kept on your device so you can play without a prompt for every piece. On
            Android it is in the phone&rsquo;s secure storage (the Android Keystore). On the web it is in your
            browser&rsquo;s storage and cannot be read out of it. Only its public half leaves your device.
          </li>
          <li>
            <Em>Settings and practice balance</Em>, kept on your device.
          </li>
          <li>
            <Em>The camera</Em>, on Android, only if you scan a QR code for an address to withdraw to. The picture stays on
            your phone.
          </li>
        </List>
        <P>
          <Em>On the web only</Em>, we also collect how the app is used, through PostHog, and error reports, through
          Sentry. Both are described below.
        </P>
        <P>
          <Em>The Android app has no analytics or crash reporting.</Em>
        </P>
      </>
    ),
  },
  {
    id: "providers",
    title: "Service providers",
    body: (
      <>
        <P>These companies process data for us, only to run skech:</P>
        <List>
          <li>
            <Em>Privy</Em> (<A href="https://privy.io">privy.io</A>) runs sign-in. It holds your email or phone number
            and the key shares that secure your embedded wallet. We never see or hold your wallet&rsquo;s private key.
            Privy may use Cloudflare to check that a sign-in is not a bot.
          </li>
          <li>
            <Em>PostHog</Em>, web app only, for product analytics: the screens you open, steps like signing in,
            depositing and withdrawing, each round&rsquo;s result, how long you play, and how fast pages load. It also
            records sessions of the screen. Everything you type is masked in recordings, and so is the sign-in panel.
            Text that shows your email or phone number is left out.
          </li>
          <li>
            <Em>Sentry</Em>, web app and our servers, for error reports: what broke, the steps in the game that led to it,
            and, on the web, a recording of the last minute on screen before the error, masked the same way. Our servers
            send errors with no user details, cookies or request bodies.
          </li>
          <li>
            <Em>QuickNode</Em> and other blockchain RPC providers, which pass our requests, and on the web your
            browser&rsquo;s, to the blockchain. They see the IP address that sends each request.
          </li>
          <li>
            <Em>Amazon Web Services</Em>, which hosts our game servers (in India).
          </li>
          <li>
            <Em>Vercel</Em>, which hosts this website and the web app.
          </li>
        </List>
        <P>
          Bitcoin&rsquo;s price comes from Coinbase&rsquo;s public feed. Nothing about you is sent to Coinbase.
        </P>
      </>
    ),
  },
  {
    id: "why",
    title: "Why we use it",
    body: (
      <>
        <List>
          <li>
            <Em>To run the game you asked for</Em>: sign you in, place your pieces, settle them, and move your money in
            and out.
          </li>
          <li>
            <Em>To keep it working and safe</Em>: limit abuse, find and fix errors, and spot fraud.
          </li>
          <li>
            <Em>To make it better</Em>: see which parts of the app are used and where people get stuck.
          </li>
          <li>
            <Em>To answer you</Em>, when you write to us.
          </li>
          <li>
            <Em>To meet the law</Em>, where it requires us to keep or share something.
          </li>
        </List>
        <P>
          Where a law asks for a legal basis, ours are: running our agreement with you (the{" "}
          <A href="/terms">terms</A>), our legitimate interests in keeping skech secure and improving it, meeting legal
          obligations, and your consent where we ask for it.
        </P>
        <P>
          <Em>We do not show ads. We do not sell your data.</Em>
        </P>
      </>
    ),
  },
  {
    id: "sharing",
    title: "Who else sees it",
    body: (
      <List>
        <li>The service providers above, only to do their job for us.</li>
        <li>Anyone at all, for what is on the blockchain. That is how public blockchains work.</li>
        <li>Authorities, where the law requires it.</li>
        <li>A buyer of skech or its business, if that ever happens. This policy would still apply to your data.</li>
      </List>
    ),
  },
  {
    id: "retention",
    title: "How long we keep it",
    body: (
      <List>
        <li>
          <Em>On the blockchain:</Em> forever. No one can delete it.
        </li>
        <li>
          <Em>Your Privy sign-in:</Em> until you ask us to delete your account.
        </li>
        <li>
          <Em>Our records tied to your address:</Em> until you ask us to delete them, or we stop running skech.
        </li>
        <li>
          <Em>Your IP address:</Em> only while the rate limit needs it, in memory. Hosting logs keep it for a short time.
        </li>
        <li>
          <Em>PostHog and Sentry data:</Em> for a limited period set by our plan with each, then deleted.
        </li>
        <li>
          <Em>Emails and messages:</Em> as long as we need them to help you.
        </li>
        <li>Anything the law requires us to keep, for as long as it requires.</li>
      </List>
    ),
  },
  {
    id: "security",
    title: "Security",
    body: (
      <>
        <List>
          <li>Your balance is held by the game&rsquo;s smart contract, not by us.</li>
          <li>Withdrawals need your wallet&rsquo;s signature. The drawing key on your device cannot withdraw.</li>
          <li>Everything between the app and our servers is encrypted in transit.</li>
          <li>We keep access to our servers and providers to the people who need it.</li>
        </List>
        <P>No system is perfectly secure. If we learn of a breach that affects you, we will tell you as the law requires.</P>
      </>
    ),
  },
  {
    id: "rights",
    title: "Your rights",
    body: (
      <>
        <P>Depending on where you live, you can ask us to:</P>
        <List>
          <li>show you the data we hold about you, and give you a copy;</li>
          <li>correct it;</li>
          <li>delete it;</li>
          <li>stop or limit using it, including for analytics.</li>
        </List>
        <P>
          Email <Contact /> from the address or phone number you signed in with, and include your wallet address. We may
          need to check it is you. We reply within 30 days.
        </P>
        <P>
          We cannot change or delete anything on the blockchain. To delete your account, follow the steps on{" "}
          <A href="/delete-account">Delete your account</A>.
        </P>
        <P>You can also complain to your local data protection authority.</P>
      </>
    ),
  },
  {
    id: "children",
    title: "Children",
    body: (
      <P>
        skech is for people 18 and over only. We do not knowingly collect data from anyone younger. If we learn we have,
        we delete what we can.
      </P>
    ),
  },
  {
    id: "transfers",
    title: "International transfers",
    body: (
      <P>
        Our providers process data in the United States, India and other countries, which may
        have different data protection laws from yours. Where the law requires it, we rely on safeguards such as standard
        contractual clauses.
      </P>
    ),
  },
  {
    id: "changes",
    title: "Changes",
    body: (
      <P>
        When we change this policy, we update the date at the top. If a change matters, we also say so in the app or on
        this site before it takes effect.
      </P>
    ),
  },
  {
    id: "contact",
    title: "Contact",
    body: (
      <P>
        Questions or requests: <Contact />.
      </P>
    ),
  },
];

export default function PrivacyPage() {
  return (
    <LegalPage
      lead="What skech collects about you, why, who else sees it, and how to have it deleted. Most of what skech records is on a public blockchain, where anyone can read it."
      sections={SECTIONS}
      title="Privacy policy"
    />
  );
}
