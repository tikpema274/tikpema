import ConnectPasskey from "./components/ConnectPasskey";
import AgentPanel from "./components/AgentPanel";

export default function App() {
  return (
    <div className="app">
      <div className="title">Tikpema</div>
      <div className="tagline">
        Two planes on Arc Testnet · humans sign with passkeys, the agent acts on its own
      </div>
      <ConnectPasskey />
      <AgentPanel />
    </div>
  );
}
