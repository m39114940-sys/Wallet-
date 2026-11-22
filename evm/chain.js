// Testnet chain descriptor for the EVM layer (NEW Testnet only, Chain ID 20261122).
// The hardfork is pinned explicitly to "shanghai" so no default (London or experimental) is ever used.
// All listed forks activate at block 0 because the chain starts at Shanghai rules.
// The consensus field is descriptive only: the real hybrid PoW+PoS rules live in chain/, not in EVM.
import { EVM_CHAIN_IDS } from "./params.js";

export const TESTNET_HARDFORK = "shanghai";

const FORKS_UP_TO_SHANGHAI = [
  "chainstart",
  "homestead",
  "dao",
  "tangerineWhistle",
  "spuriousDragon",
  "byzantium",
  "constantinople",
  "petersburg",
  "istanbul",
  "muirGlacier",
  "berlin",
  "london",
  "arrowGlacier",
  "grayGlacier",
  "mergeNetsplitBlock",
  "paris",
  "shanghai",
];

export function testnetChainConfig() {
  return {
    name: "snn-testnet",
    chainId: Number(EVM_CHAIN_IDS.testnet),
    defaultHardfork: TESTNET_HARDFORK,
    comment: "SmartNode Network EVM Testnet (new chain). Prototype, not for real funds.",
    genesis: {
      gasLimit: 30_000_000,
      difficulty: 0,
      nonce: "0x0000000000000000",
      extraData: "0x",
    },
    hardforks: FORKS_UP_TO_SHANGHAI.map((name) => ({ name, block: 0 })),
    bootstrapNodes: [],
    dnsNetworks: [],
    consensus: { type: "other", algorithm: "snn-hybrid-pow-pos" },
  };
}
