// Draft for legal review before launch.
import type { Metadata } from "next";
import { A, Contact, Em, LegalPage, type LegalSection, List, P } from "@/components/site/legal";
import { IOU_GROWTH, PROFIT_FEE, STAKE_FEE } from "@/lib/legal";

const DESCRIPTION = "The rules for using skech: who can play, how it works, what it costs, and what can go wrong.";

export const metadata: Metadata = {
  title: "Terms of use | skech",
  description: DESCRIPTION,
  alternates: { canonical: "/terms" },
  openGraph: { title: "Terms of use | skech", description: DESCRIPTION, url: "/terms", siteName: "skech", type: "website" },
};

const SECTIONS: LegalSection[] = [
  {
    id: "about",
    title: "About these terms",
    body: (
      <>
        <P>
          These terms are an agreement between you and <Em>skech</Em>, the team that runs it. They cover this website,
          the web app (app.skech.trade) and the skech Android app.
        </P>
        <P>By using skech, you agree to them. If you do not agree, do not use skech.</P>
        <P>
          Our <A href="/privacy">privacy policy</A> explains what we collect and why.
        </P>
      </>
    ),
  },
  {
    id: "eligibility",
    title: "Who can use skech",
    body: (
      <>
        <List>
          <li>
            You must be <Em>18 or older</Em>.
          </li>
          <li>
            You must not be in, or a resident of, a place where using skech is against the law. You are responsible for knowing the law where you are.
          </li>
          <li>You must not be on a sanctions list, or acting for someone who is.</li>
          <li>You must use skech for yourself, not on behalf of someone else.</li>
        </List>
        <P>
          Some places restrict or ban products like skech. <Em>You are responsible for knowing and following the law where
          you are.</Em> Do not use skech where it is against the law, and do not hide where you are to get around these
          limits.
        </P>
      </>
    ),
  },
  {
    id: "how-it-works",
    title: "How skech works",
    body: (
      <>
        <P>
          skech is a Bitcoin price prediction game. You draw where you think Bitcoin&rsquo;s price goes over the next few
          seconds. The parts of your line the price passes through pay a set multiple. The parts it misses, you lose what
          you put on them.
        </P>
        <List>
          <li>You draw on a live Bitcoin chart, up to 30 seconds ahead.</li>
          <li>You choose what each dot of ink costs. A line costs that amount times the ink it uses.</li>
          <li>Your ink is placed as you draw, in small pieces. Each piece is a transaction on the blockchain.</li>
          <li>
            Each part of a piece gets a multiple when it is placed, from 1&times; to 128&times;. The less likely the price
            is to reach it, the higher the multiple. The chart shows these multiples before you draw.
          </li>
          <li>
            When each second ends, every part of your ink the price passed through in that second pays its multiple of
            what you put on it. Every part it missed is lost.
          </li>
          <li>
            <Em>The multiples are set so that, on average, players get back less than they put in.</Em>
          </li>
          <li>If a second&rsquo;s price is never recorded on the blockchain, what you put on that second is returned.</li>
        </List>
        <P>
          The price is Coinbase&rsquo;s BTC-USD price, checked against other exchanges by our servers and recorded on the blockchain each second.
          That recorded price decides every result.
        </P>
      </>
    ),
  },
  {
    id: "networks",
    title: "Networks, money and practice",
    body: (
      <List>
        <li>skech uses USDC, a dollar stablecoin.</li>
        <li>skech runs on Solana: devnet now, and Solana mainnet later.</li>
        <li>
          <Em>On a testnet or devnet, USDC is a test token with no value.</Em> Balances there may be reset at any time.
        </li>
        <li>On a mainnet, you play with real USDC, and what you lose is real money.</li>
        <li>Practice mode uses play money inside the app. It has no value and cannot be withdrawn.</li>
      </List>
    ),
  },
  {
    id: "fees",
    title: "Fees",
    body: (
      <>
        <List>
          <li>
            <Em>{STAKE_FEE} of every stake</Em>, taken when a piece is placed.
          </li>
          <li>
            <Em>{PROFIT_FEE} of the profit on every win</Em>, taken when it is paid. It is taken only from what the pool
            has left after paying you.
          </li>
          <li>We pay the blockchain&rsquo;s network fees for play, deposits and withdrawals sent through our servers, within limits.</li>
        </List>
        <P>We may change the fees. When we do, we update these terms first.</P>
      </>
    ),
  },
  {
    id: "pool",
    title: "The pool, and IOUs",
    body: (
      <>
        <List>
          <li>Every stake goes into one shared pool, held by the game&rsquo;s smart contract. Every win is paid from it.</li>
          <li>
            If the pool cannot pay a win in full, you are paid what it can pay, and <Em>the rest is owed to you as an
            IOU</Em>.
          </li>
          <li>An IOU grows at a set rate, currently {IOU_GROWTH}, until it is paid.</li>
          <li>
            IOUs are paid into your balance as the pool refills from other players&rsquo; losses. We send these repayments
            automatically.
          </li>
          <li>
            Anyone may send a repayment once the pool can cover it. If someone else repays yours, they keep 10% of what
            it grew by.
          </li>
          <li>
            <Em>There is no promise of when an IOU is paid.</Em> If players keep winning more than they lose, it may take a
            long time, or may never be paid in full.
          </li>
        </List>
      </>
    ),
  },
  {
    id: "wallet",
    title: "Your wallet and keys",
    body: (
      <List>
        <li>
          If you sign in with Privy, a wallet is made for you at sign-in and secured by Privy. On Android you can use your
          own Solana wallet app instead, such as Phantom or Solflare.
        </li>
        <li>Your balance is held by the game&rsquo;s smart contract on the blockchain, not by us.</li>
        <li>
          The app makes a drawing key on your device, so you can play without a prompt for every piece. It can only place
          pieces, up to an allowance and until it expires. It cannot withdraw.
        </li>
        <li>Withdrawals need your wallet&rsquo;s signature.</li>
        <li>USDC sent to your skech address is moved into your game balance automatically.</li>
        <li>
          <Em>Keep your sign-in and your wallet safe.</Em> If you lose access to them, you may lose your funds. We cannot
          recover a wallet for you.
        </li>
        <li>Blockchain transactions cannot be reversed. Check an address before you withdraw to it.</li>
      </List>
    ),
  },
  {
    id: "risks",
    title: "Risks",
    body: (
      <>
        <P>Read these before you put money in.</P>
        <List>
          <li>
            <Em>You can lose everything you put in.</Em> Most ink is missed. Never put in more than you would be fine
            losing.
          </li>
          <li>On average, you get back less than you put in.</li>
          <li>
            <Em>Price feed.</Em> If the price feed is wrong, late or stops, results can be affected. A second with no
            recorded price is returned.
          </li>
          <li>
            <Em>Outages.</Em> If the blockchain, our servers or a provider like Privy is down or slow, your pieces may not
            be placed, results may be late, and you may not be able to play or withdraw for a while.
          </li>
          <li>
            <Em>Smart contracts.</Em> The game runs on smart contracts that may have bugs. Their administrator can
            upgrade them and change their settings.
          </li>
          <li>
            <Em>A short pool.</Em> A win may be paid partly as an IOU, and an IOU may be paid late or never in full.
          </li>
          <li>
            <Em>Test networks.</Em> Testnet and devnet tokens have no value and may be reset.
          </li>
          <li>
            <Em>The law.</Em> Rules for products like skech can change, and we may have to stop offering it where you
            are.
          </li>
          <li>
            <Em>Taxes.</Em> You are responsible for any tax on what you win.
          </li>
        </List>
      </>
    ),
  },
  {
    id: "prohibited",
    title: "What you must not do",
    body: (
      <List>
        <li>Use skech where it is not allowed, or hide where you are to get around that.</li>
        <li>Use bots or scripts to overload our servers, get around our limits, or exploit pricing.</li>
        <li>Exploit a bug, a pricing error or a price feed error instead of reporting it to us.</li>
        <li>Open more than one account to get around limits.</li>
        <li>Use skech for money laundering, terrorist financing, sanctions evasion, or with money from crime.</li>
        <li>Attack or interfere with our servers, the smart contracts, or other players.</li>
        <li>Use someone else&rsquo;s account or wallet without their permission.</li>
      </List>
    ),
  },
  {
    id: "suspension",
    title: "Suspension and ending",
    body: (
      <List>
        <li>
          We may block an address or device from our apps and servers if it breaks these terms, or where the law requires
          it.
        </li>
        <li>We may pause play for everyone, for example to fix a bug.</li>
        <li>Pausing stops new play and deposits. It does not stop withdrawals: the contract lets you withdraw your balance.</li>
        <li>We may stop offering skech. If we do, we will give notice where we can, so you can withdraw.</li>
        <li>You can stop using skech at any time. Withdraw your balance first.</li>
      </List>
    ),
  },
  {
    id: "no-advice",
    title: "No investment advice",
    body: (
      <>
        <P>Nothing on skech is investment, financial, legal or tax advice.</P>
        <P>The multiples and the chart are not predictions or recommendations.</P>
      </>
    ),
  },
  {
    id: "disclaimers",
    title: "Disclaimers",
    body: (
      <>
        <P>skech is provided as is and as available.</P>
        <P>We do not promise it will be uninterrupted, free of errors, or secure.</P>
        <P>
          We do not control the blockchains, wallet apps, Privy, the price feed, or USDC, and we are not responsible for
          them.
        </P>
      </>
    ),
  },
  {
    id: "liability",
    title: "Limitation of liability",
    body: (
      <>
        <P>As far as the law allows:</P>
        <List>
          <li>we are not liable for indirect or consequential losses, or lost profits;</li>
          <li>we are not liable for losses from the risks listed above;</li>
          <li>our total liability to you is limited to the fees you paid in the 12 months before the claim.</li>
        </List>
        <P>Nothing in these terms limits liability that the law does not let us limit, such as for fraud.</P>
      </>
    ),
  },
  {
    id: "changes",
    title: "Changes",
    body: (
      <P>
        We may change these terms. When we do, we update the date at the top. If a change matters, we also say so in the
        app or on this site before it takes effect. Using skech after that means you accept the new terms.
      </P>
    ),
  },
  {
    id: "law",
    title: "Governing law",
    body: (
      <P>
        Disputes about these terms go to the courts that have jurisdiction over skech, unless the law where you live gives
        you the right to use your local courts. Nothing in these terms takes away rights that law gives you.
      </P>
    ),
  },
  {
    id: "contact",
    title: "Contact",
    body: (
      <P>
        Questions, or a bug to report: <Contact />.
      </P>
    ),
  },
];

export default function TermsPage() {
  return (
    <LegalPage
      lead="The rules for using skech: who can play, how it works, what it costs, and what can go wrong. You can lose everything you put in."
      sections={SECTIONS}
      title="Terms of use"
    />
  );
}
