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
      <div className="tagline">
        Two planes on Arc Testnet · humans sign with passkeys, the agent acts on its own
      </div>
      <ConnectPasskey wallet={wallet} />
      <AgentPanel />
      <PredictPanel wallet={wallet} />
      <FeedbackPanel wallet={wallet} />
    </div>
  );
}
