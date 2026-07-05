import ConnectPasskey from "./components/ConnectPasskey";
import ResearchPanel from "./components/ResearchPanel";
import MyAgentPanel from "./components/MyAgentPanel";
import FeedbackPanel from "./components/FeedbackPanel";
import { useWallet } from "./wallet/useWallet";

// The stranger-facing app frames ONE agent: set up a wallet, fund it, then give
// the agent a task — research (the flagship), or send/swap/multi-step actions.
// AgentPanel (a dev sandbox) and PredictPanel (the same research loop wearing a
// second hat) are intentionally NOT mounted here — their files are kept and
// revivable, just not part of the front door. See the audit.

// The four real steps of the loop, in order — a genuine sequence, so numbering
// carries information rather than decoration. Broad enough to set up BOTH the
// research desk and the "give your agent a task" (send/swap/multi-step) surface.
const STEPS = [
  {
    n: "01",
    title: "Continue with your passkey",
    body: "Log in — or create a wallet on first use — in one tap with Face or Touch ID. No seed phrase, no password. MetaMask works too.",
  },
  {
    n: "02",
    title: "Add test USDC",
    body: "Grab free testnet USDC from the faucet. It funds your agent's own wallet — what it researches and transacts with.",
  },
  {
    n: "03",
    title: "Give your agent a task",
    body: "In plain language: ask a factual question for a cited brief, or tell it to send or swap USDC — one step or several.",
  },
  {
    n: "04",
    title: "It acts — safely",
    body: "Your agent researches, sends, or swaps on-chain and settles in USDC — every action bounded by your per-transaction and daily caps.",
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
          <span className="eyebrow">Autonomous agent</span>
        </div>
        <span className="chip">
          <span className="dot">●</span> Arc Testnet
        </span>
      </header>

      <section className="hero">
        <p className="hero-eyebrow">Autonomous AI agent · its own wallet · USDC on Arc</p>
        <h1 className="hero-title">
          Your autonomous agent, <em>on Arc.</em>
        </h1>
        <div className="hero-rule" />
        <p className="hero-lede">
          Tikpema is an AI agent with its <b>own on-chain wallet</b>. Ask in plain
          language and it <b>researches with cited sources</b>, sends and swaps
          USDC, and runs multi-step tasks — <b>gasless, no seed phrase</b>, and
          kept within <b>per-transaction and daily spending caps</b>. Research is
          its proven flagship; the rest it does on your behalf, on-chain, in seconds.
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
        <span>Gasless USDC on Arc · passkeys by Circle</span>
      </footer>
    </div>
  );
}
