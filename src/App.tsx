import ConnectPasskey from "./components/ConnectPasskey";
import ResearchPanel from "./components/ResearchPanel";
import MyAgentPanel from "./components/MyAgentPanel";
import FeedbackPanel from "./components/FeedbackPanel";
import { useWallet } from "./wallet/useWallet";

// The stranger-facing app is deliberately ONE loop: create a wallet, then hire
// the research analyst. AgentPanel (a dev sandbox) and PredictPanel (the same
// research loop wearing a second hat) are intentionally NOT mounted here — their
// files are kept and revivable, just not part of the front door. See the audit.

// The four real steps of the loop, in order — a genuine sequence, so numbering
// carries information rather than decoration.
const STEPS = [
  {
    n: "01",
    title: "Create your wallet",
    body: "One tap with a passkey — Face or Touch ID. No seed phrase, no password.",
  },
  {
    n: "02",
    title: "Add test USDC",
    body: "Grab free testnet USDC from the faucet. It pays for the research.",
  },
  {
    n: "03",
    title: "Ask a question",
    body: "Anything with a factual answer. You see the price before you commit.",
  },
  {
    n: "04",
    title: "Get a sourced brief",
    body: "The analyst researches, cites its sources, and payment settles on-chain.",
  },
];

export default function App() {
  // One passkey wallet instance, shared across the wallet step and the research
  // loop so the user hires with the exact account they created.
  const wallet = useWallet();

  return (
    <div className="app">
      <header className="masthead">
        <div className="wordmark">
          <b>
            Tikpema<span className="seal">.</span>
          </b>
          <span className="eyebrow">Research desk</span>
        </div>
        <span className="chip">
          <span className="dot">●</span> Arc Testnet
        </span>
      </header>

      <section className="hero">
        <p className="hero-eyebrow">AI research analyst · paid in USDC on Arc</p>
        <h1 className="hero-title">
          Hire an analyst to <em>research your question.</em>
        </h1>
        <div className="hero-rule" />
        <p className="hero-lede">
          Ask anything with a factual answer. Tikpema's agent searches real
          sources, writes you a <b>cited brief</b>, and only gets paid when the
          work is delivered — <b>settled on-chain in seconds</b>. No seed phrase,
          no account. Just a passkey.
        </p>

        <div className="process">
          {STEPS.map((s) => (
            <div className="step" key={s.n}>
              <div className="step-num">{s.n}</div>
              <div className="step-title">{s.title}</div>
              <div className="step-body">{s.body}</div>
            </div>
          ))}
        </div>
      </section>

      <ConnectPasskey wallet={wallet} />
      <ResearchPanel wallet={wallet} />
      <MyAgentPanel wallet={wallet} />
      <FeedbackPanel wallet={wallet} />

      <footer className="deskfoot">
        <span>Tikpema · testnet demo</span>
        <span>USDC settlement on Arc · powered by Circle passkeys</span>
      </footer>
    </div>
  );
}
