import ConnectPasskey from "./components/ConnectPasskey";
import AgentPanel from "./components/AgentPanel";
import PredictPanel from "./components/PredictPanel";

export default function App() {
  return (
    <div className="app">
      <div className="title">Tikpema</div>
      <div className="tagline">
        Two planes on Arc Testnet · humans sign with passkeys, the agent acts on its own
      </div>
      <ConnectPasskey />
      <AgentPanel />
      <PredictPanel />
    </div>
  );
}
