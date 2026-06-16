// Circle Gateway constants for Arc Testnet. Confirmed facts — do not re-derive.
//
// Gateway lets the agent hold a single USDC "unified balance" backed by deposits
// across chains. On Arc Testnet you deposit USDC into the Gateway Wallet contract
// (approve + deposit), then read the unified balance from the Gateway API.
export const GATEWAY = {
  // Gateway Wallet contract (deposit target) on Arc Testnet.
  WALLET: "0x0077777d7EBA4688BDeF3E311b846F25870A19B9",
  // REST API for reading unified balances / building transfers.
  API_BASE: "https://gateway-api-testnet.circle.com",
  // Circle's domain id for Arc in the Gateway/CCTP domain space.
  ARC_DOMAIN: 26,
};
