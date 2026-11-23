// EVM receipts for the new Testnet. They are derived from certified blocks and never stored in them,
// so block hashes and state roots do not change. Each receipt is rebuilt from the entry's signed fields,
// so its transaction hash is the one the wallet computed for the raw transaction.
import { createLegacyTx } from "@ethereumjs/tx";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { createTestnetCommon } from "../evm/engine.js";
import { TESTNET_GAS_POLICY } from "../evm/params.js";
import { INTRINSIC_GAS } from "../evm/transfer.js";

const hexOf = (bytes) => "0x" + Buffer.from(bytes).toString("hex");
const toHex = (n) => "0x" + BigInt(n).toString(16);
const ZERO_BLOOM = "0x" + "00".repeat(256);

// The signed legacy transaction an entry stands for.
function signedTxOf(entry) {
  return createLegacyTx(
    {
      nonce: BigInt(entry.nonce),
      gasPrice: TESTNET_GAS_POLICY.gasPriceBase,
      gasLimit: BigInt(entry.gasLimit),
      to: Uint8Array.from(Buffer.from(entry.to.slice(2), "hex")),
      value: BigInt(entry.value),
      data: new Uint8Array(0),
      v: BigInt(entry.v),
      r: BigInt(entry.r),
      s: BigInt(entry.s),
    },
    { common: createTestnetCommon() },
  );
}

// Receipts for the EVM entries of one block, in block order, as [{ hash, receipt }]. Empty when the block has none.
// Every entry in a certified block succeeded, so each receipt reports success.
export function receiptsOfBlock(block) {
  if (!Array.isArray(block.evmTxs) || block.evmTxs.length === 0) return [];
  let cumulative = 0n;
  return block.evmTxs.map((entry, index) => {
    const tx = signedTxOf(entry);
    cumulative += INTRINSIC_GAS;
    const hash = hexOf(keccak_256(tx.serialize()));
    return {
      hash,
      receipt: {
        transactionHash: hash,
        transactionIndex: toHex(index),
        blockHash: block.hash,
        blockNumber: toHex(block.height),
        from: tx.getSenderAddress().toString().toLowerCase(),
        to: entry.to,
        cumulativeGasUsed: toHex(cumulative),
        gasUsed: toHex(INTRINSIC_GAS),
        effectiveGasPrice: toHex(TESTNET_GAS_POLICY.gasPriceBase),
        contractAddress: null,
        logs: [],
        logsBloom: ZERO_BLOOM,
        status: "0x1",
        type: "0x0",
      },
    };
  });
}
