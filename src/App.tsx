import ConnectPasskey from "./components/ConnectPasskey";
import AgentPanel from "./components/AgentPanel";
import PredictPanel from "./components/PredictPanel";
import FeedbackPanel from "./components/FeedbackPanel";
import { useModularWallet } from "./wallet/useModularWallet";

export default function App() {
  // One passkey wallet instance, shared so the Predict plane can let the
  // connected user place their own bet using the same account the Human plane
  // registered/logged in with.
  const wallet = useModularWallet();

  return (
    <div className="app">
      <div className="title">Tikpema</div>
      <div className="tagline" style={{ marginBottom: 8 }}>
        Predict real-world outcomes on Arc · an AI assistant helps you decide
      </div>
      <div style={{ color: "var(--muted)", fontSize: 14, marginBottom: 28 }}>
        New here? Start in <b>Your Wallet</b> — choose a username and tap{" "}
        <b>Register passkey</b> to create your wallet. Then explore the markets
        below.
      </div>
      <ConnectPasskey wallet={wallet} />
      <AgentPanel />
      <PredictPanel wallet={wallet} />
      <FeedbackPanel wallet={wallet} />
    </div>
  );
}
