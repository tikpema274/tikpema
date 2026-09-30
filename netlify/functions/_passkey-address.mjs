// _passkey-address.mjs — the address of a passkey's Circle smart account, DERIVED from its P-256 public key.
//
// ═══ WHY THE SERVER DERIVES IT (2026-09-30) ═══════════════════════════════════════════════════════════
// auth-verify's passkey registration (ab85757, 2026-07-03) bound a new credential to the address the CLIENT sent, so a
// software key and any address got a session — mitigated 94ef870 by refusing all sign-ups. The proper fix removes the
// client's address from the decision: a Circle MSCA's address is a pure CREATE2 of its key, so the server computes it.
//
//   address = CREATE2(factory, keccak(sender ‖ salt), keccak(proxyCreationCode ‖ abi(implementation, initData)))
//     sender   = keccak(abi(uint256 x, uint256 y))            — the key IS the salt
//     salt     = 0 (bytes32)                                   — the SDK's getSalt()
//     initData = initializeUpgradableMSCA([plugin], [manifestHash], [abi(no EOA owners, the key at weight 1, threshold 1)])
//
// These are the constants of @circle-fin/modular-wallets-core 1.0.13, whose computeAddress(owner) is internal and NOT
// exported. The browser does not compute it: toCircleSmartAccount asks Circle (circle_getAddress). Pinned to BOTH by
// scripts/verify-passkey-address.mjs — the SDK's own computeAddress (200 random keys), 0xfd80…5767's key from its own
// on-chain deployment, and (--onchain) the factory's getAddress view on Arc testnet AND mainnet 5042 (same factory).
// ⚠️ A modular-wallets-core upgrade that changes any of these would split identities: the suite fails first.
// Measured 2026-09-30 over the 19 stored credentials: 16 match; the 3 that do not are 2026-07-03 software-authenticator
// test artifacts (PROGRESS, 6d1cbab) — auth-verify refuses them.
import { encodeAbiParameters, encodeFunctionData, encodePacked, getContractAddress, keccak256 } from "viem";

export const PASSKEY_ACCOUNT = Object.freeze({
  factory: "0x0000000DF7E6c9Dc387cAFc5eCBfa6c3a6179AdD",
  implementation: "0xA70F1296869DA9D7CB69578123F21888E6dB2B62",
  plugin: "0x0000000C984AFf541D6cE86Bb697e68ec57873C8",
  pluginManifestHash: "0xa043327d77a74c1c55cfa799284b831fe09535a88b9f5fa4173d334e5ba0fd91",
  // ERC1769_PROXY.creationCode (723 bytes)
  proxyCreationCode:
  "0x60806040526102d38038038061001481610194565b92833981019060408183031261018f5780516001600160a01b03811680820361018f5760" +
  "208381015190936001600160401b03821161018f570184601f8201121561018f5780519061006d610068836101cf565b610194565b9582875285" +
  "838301011161018f57849060005b83811061017b57505060009186010152813b15610163577f360894a13ba1a3210667c828492db98dca3e2076" +
  "cc3735a920a3ca505d382bbc80546001600160a01b03191682179055604051907fbc7cd75a20ee27fd9adebab32041f755214dbc6bffa90cc022" +
  "5b39da2e5c2d3b600080a28351156101455750600080848461012c96519101845af4903d1561013c573d61011c610068826101cf565b90815260" +
  "0081943d92013e6101ea565b505b6040516085908161024e8239f35b606092506101ea565b9250505034610154575061012e565b63b398979f60" +
  "e01b8152600490fd5b60249060405190634c9c8ce360e01b82526004820152fd5b818101830151888201840152869201610080565b600080fd5b" +
  "6040519190601f01601f191682016001600160401b038111838210176101b957604052565b634e487b7160e01b600052604160045260246000fd" +
  "5b6001600160401b0381116101b957601f01601f191660200190565b9061021157508051156101ff57805190602001fd5b604051630a12f52160" +
  "e11b8152600490fd5b81511580610244575b610222575090565b604051639996b31560e01b81526001600160a01b039091166004820152602490" +
  "fd5b50803b1561021a56fe60806040527f360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc546000908190819060" +
  "01600160a01b0316368280378136915af43d82803e15604b573d90f35b3d90fdfea26469706673582212204c5a8d3706486893377786ce0546dc" +
  "d68cc8da5f34f8cc074c787db78fc29df764736f6c63430008180033",
});

const SALT = "0x" + "00".repeat(32);
const KEY_TUPLE = { type: "tuple[]", components: [{ name: "x", type: "uint256" }, { name: "y", type: "uint256" }] };
const PLUGIN_INSTALL = [{ type: "address[]" }, { type: "uint256[]" }, KEY_TUPLE, { type: "uint256[]" }, { type: "uint256" }];
const INITIALIZE_ABI = [{ type: "function", name: "initializeUpgradableMSCA", stateMutability: "nonpayable", outputs: [],
  inputs: [{ name: "plugins", type: "address[]" }, { name: "manifestHashes", type: "bytes32[]" }, { name: "pluginInstallData", type: "bytes[]" }] }];

// P-256: y² = x³ − 3x + b (mod p)
const P = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn;
const B = 0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604bn;

/** The P-256 key as {x, y}. Accepts 0x04‖x‖y (65 bytes) or 0x‖x‖y (64 bytes, Circle's form). Throws on anything else,
 *  including a point that is not on the curve — a malformed key never yields an address. */
export function parsePasskeyPublicKey(publicKey) {
  if (typeof publicKey !== "string" || !/^0x(04)?[0-9a-fA-F]{128}$/.test(publicKey)) throw new Error("passkey public key must be 0x04‖x‖y or 0x‖x‖y (hex)");
  const hex = publicKey.length === 132 ? publicKey.slice(4) : publicKey.slice(2);
  const x = BigInt("0x" + hex.slice(0, 64)), y = BigInt("0x" + hex.slice(64));
  if (x >= P || y >= P || (y * y - (x * x * x - 3n * x + B)) % P !== 0n) throw new Error("passkey public key is not a P-256 point");
  return { x, y };
}

/** The Circle MSCA address this key owns — lowercase. The only address a passkey session may carry. */
export function derivePasskeyAddress(publicKey) {
  const { x, y } = parsePasskeyPublicKey(publicKey);
  const sender = keccak256(encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [x, y]));
  const installData = encodeAbiParameters(PLUGIN_INSTALL, [[], [], [{ x, y }], [1n], 1n]);
  const initData = encodeFunctionData({ abi: INITIALIZE_ABI, functionName: "initializeUpgradableMSCA",
    args: [[PASSKEY_ACCOUNT.plugin], [PASSKEY_ACCOUNT.pluginManifestHash], [installData]] });
  const bytecode = encodePacked(["bytes", "bytes"], [PASSKEY_ACCOUNT.proxyCreationCode,
    encodeAbiParameters([{ type: "address" }, { type: "bytes" }], [PASSKEY_ACCOUNT.implementation, initData])]);
  const salt = keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }], [sender, SALT]));
  return getContractAddress({ bytecode, from: PASSKEY_ACCOUNT.factory, opcode: "CREATE2", salt }).toLowerCase();
}
