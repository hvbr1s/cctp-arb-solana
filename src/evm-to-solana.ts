import "dotenv/config";
import { getProvider } from "./get-provider";
import {signWithApiSigner } from "./signer";
import {createAndSignTx} from './process_tx'
import {
  fordefiConfigFrom,
  bridgeConfigSolana
} from "./config";
import {
  createWalletClient,
  createPublicClient,
  custom,
  http,
  parseUnits,
  keccak256,
  encodeFunctionData,
} from "viem";
import { arbitrum } from "viem/chains";
import {
  Connection,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  TransactionInstruction,
  SystemProgram,
  Transaction,
  ComputeBudgetProgram,
  AddressLookupTableProgram,
  AddressLookupTableAccount,
} from "@solana/web3.js";
import { getAssociatedTokenAddress, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import bs58 from "bs58";
import { MESSAGE_TRANSMITTER_PROGRAM_ID, TOKEN_MESSENGER_MINTER_PROGRAM_ID, SOLANA_USDC_MINT, SOLANA_DOMAIN, ARBITRUM_DOMAIN, TOKEN_MESSENGER, ARBITRUM_USDC  } from "./config";
import {
  getProgramsV2,
  getReceiveMessagePdasV2,
  decodeEventNonceFromMessageV2
} from "../solana-cctp-contracts/examples/v2/utilsV2";
import * as anchor from "@coral-xyz/anchor";

/**
 * EVM to Solana CCTP Bridge with Fordefi
 *
 * This script demonstrates bridging USDC from any EVM chain to Solana:
 * 1. Burn USDC on source EVM chain using Fordefi Web3 provider + CCTP contracts directly
 * 2. Wait for Circle attestation
 * 3. Create Solana receiveMessage transaction (serialized for Fordefi remote signer)
 * 4. Submit serialized transaction to Fordefi API
 */

// ============================================================================
// Step 1: Burn USDC
// ============================================================================

async function burnUsdcOnEthereum(): Promise<{
  txHash: string;
  message: string;
  messageHash: string;
}> {
  console.log("=== Step 1: Burning USDC on EVM Chain ===\n");

  const fordefiProvider = await getProvider(fordefiConfigFrom);
  if (!fordefiProvider) {
    throw new Error("Failed to initialize Fordefi provider");
  }

  const walletClient = createWalletClient({
    chain: arbitrum,
    transport: custom(fordefiProvider),
  });

  const [fromAddress] = await walletClient.getAddresses();

  console.log(`From: ${fromAddress}`);
  console.log(`Amount: ${bridgeConfigSolana.amountUsdc} USDC`);
  console.log(`To: ${bridgeConfigSolana.solanaRecipientAddress}\n`);

  const solanaAddressBytes = bs58.decode(
    bridgeConfigSolana.solanaRecipientAddress,
  );
  const solanaAddressBytes32 =
    `0x${Buffer.from(solanaAddressBytes).toString("hex").padStart(64, "0")}` as `0x${string}`;

  const amountInSmallestUnit = parseUnits(bridgeConfigSolana.amountUsdc, 6);

  const publicClient = createPublicClient({
    chain: arbitrum,
    transport: http(fordefiConfigFrom.rpcUrl),
  });

  const usdcBalance = (await publicClient.readContract({
    address: ARBITRUM_USDC as `0x${string}`,
    abi: [
      {
        name: "balanceOf",
        type: "function",
        stateMutability: "view",
        inputs: [{ name: "account", type: "address" }],
        outputs: [{ type: "uint256" }],
      },
    ],
    functionName: "balanceOf",
    args: [fromAddress],
  })) as bigint;

  if (usdcBalance < amountInSmallestUnit) {
    throw new Error(
      `Insufficient USDC balance. Have ${Number(usdcBalance) / 1e6} USDC, need ${bridgeConfigSolana.amountUsdc} USDC`,
    );
  }

  const currentAllowance = (await publicClient.readContract({
    address: ARBITRUM_USDC as `0x${string}`,
    abi: [
      {
        name: "allowance",
        type: "function",
        stateMutability: "view",
        inputs: [
          { name: "owner", type: "address" },
          { name: "spender", type: "address" },
        ],
        outputs: [{ type: "uint256" }],
      },
    ],
    functionName: "allowance",
    args: [fromAddress, TOKEN_MESSENGER as `0x${string}`],
  })) as bigint;

  if (currentAllowance < amountInSmallestUnit) {
    console.log("Approving USDC...");
    const approveTxHash = await walletClient.writeContract({
      address: ARBITRUM_USDC as `0x${string}`,
      abi: [
        {
          name: "approve",
          type: "function",
          stateMutability: "nonpayable",
          inputs: [
            { name: "spender", type: "address" },
            { name: "amount", type: "uint256" },
          ],
          outputs: [{ type: "bool" }],
        },
      ],
      functionName: "approve",
      args: [TOKEN_MESSENGER as `0x${string}`, amountInSmallestUnit],
      account: fromAddress,
    });

    const approveReceipt = await publicClient.waitForTransactionReceipt({ hash: approveTxHash });
    if (approveReceipt.status !== "success") {
      throw new Error("Approval transaction failed");
    }

    const newAllowance = (await publicClient.readContract({
      address: ARBITRUM_USDC as `0x${string}`,
      abi: [
        {
          name: "allowance",
          type: "function",
          stateMutability: "view",
          inputs: [
            { name: "owner", type: "address" },
            { name: "spender", type: "address" },
          ],
          outputs: [{ type: "uint256" }],
        },
      ],
      functionName: "allowance",
      args: [fromAddress, TOKEN_MESSENGER as `0x${string}`],
    })) as bigint;

    if (newAllowance < amountInSmallestUnit) {
      throw new Error("Allowance still insufficient after approval");
    }

    console.log("Approved\n");
    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  const useFastTransfer = bridgeConfigSolana.useFastTransfer;
  const minFinalityThreshold = useFastTransfer ? 1000 : 2000;
  const maxFee = useFastTransfer
    ? (amountInSmallestUnit * BigInt(1)) / BigInt(10000)
    : BigInt(0);
  const destinationCaller = "0x" + "0".repeat(64);

  console.log(
    `Mode: ${useFastTransfer ? "Fast (~20s, 0.01% fee)" : "Standard (~15min, free)"}`,
  );

  const data = encodeFunctionData({
    abi: [
      {
        name: "depositForBurn",
        type: "function",
        stateMutability: "nonpayable",
        inputs: [
          { name: "amount", type: "uint256" },
          { name: "destinationDomain", type: "uint32" },
          { name: "mintRecipient", type: "bytes32" },
          { name: "burnToken", type: "address" },
          { name: "destinationCaller", type: "bytes32" },
          { name: "maxFee", type: "uint256" },
          { name: "minFinalityThreshold", type: "uint32" },
        ],
        outputs: [{ type: "uint64" }],
      },
    ],
    functionName: "depositForBurn",
    args: [
      amountInSmallestUnit,
      SOLANA_DOMAIN,
      solanaAddressBytes32,
      ARBITRUM_USDC as `0x${string}`,
      destinationCaller as `0x${string}`,
      maxFee,
      minFinalityThreshold,
    ],
  });

  const txHash = (await fordefiProvider.request({
    method: "eth_sendTransaction",
    params: [
      {
        from: fromAddress,
        to: TOKEN_MESSENGER,
        data: data,
      },
    ],
  })) as `0x${string}`;

  console.log(`Burn tx: ${txHash}`);
  console.log("Waiting for confirmation...");

  const receipt = await publicClient.waitForTransactionReceipt({
    hash: txHash,
  });
  console.log(`Confirmed (block ${receipt.blockNumber})`);
  console.log(`https://etherscan.io/tx/${txHash}\n`);

  const messageSentEventSignature = keccak256(
    Buffer.from("MessageSent(bytes)"),
  );

  const messageSentLog = receipt.logs.find(
    (log) => log.topics[0] === messageSentEventSignature,
  );

  if (!messageSentLog || !messageSentLog.data) {
    throw new Error("MessageSent event not found in transaction receipt");
  }

  const eventData = messageSentLog.data;
  const lengthHex = eventData.slice(66, 130);
  const messageLength = parseInt(lengthHex, 16);
  const messageHex = "0x" + eventData.slice(130, 130 + messageLength * 2);
  const message = messageHex as `0x${string}`;
  const messageHash = keccak256(message);

  return {
    txHash,
    message,
    messageHash,
  };
}

// ============================================================================
// Step 2: Wait for Circle Attestation
// ============================================================================

async function waitForAttestation(
  txHash: string,
): Promise<{ message: string; attestation: string }> {
  console.log("=== Step 2: Waiting for Circle Attestation ===\n");

  const isFastTransfer = bridgeConfigSolana.useFastTransfer;
  const ATTESTATION_API_URL = `https://iris-api.circle.com/v2/messages/${ARBITRUM_DOMAIN}`;
  const MAX_ATTEMPTS = isFastTransfer ? 60 : 240;

  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    try {
      const response = await fetch(`${ATTESTATION_API_URL}?transactionHash=${txHash}`);

      if (response.ok) {
        const data = await response.json();

        if (data.messages && data.messages.length > 0) {
          const messageData = data.messages[0];

          const isAttestationReady =
            messageData.attestation &&
            messageData.attestation !== "PENDING" &&
            messageData.attestation.startsWith("0x");

          if (isAttestationReady) {
            console.log("Attestation received\n");
            return {
              message: messageData.message,
              attestation: messageData.attestation,
            };
          }

          if (i % 12 === 0) {
            const elapsedSeconds = i * 5;
            const elapsedMinutes = Math.floor(elapsedSeconds / 60);
            const remainingSeconds = elapsedSeconds % 60;
            console.log(`[${elapsedMinutes}m ${remainingSeconds}s] Waiting...`);
          }
        }
      }
    } catch (error) {
      // Silent retry
    }

    await new Promise((resolve) => setTimeout(resolve, 5000));
  }

  const timeoutMinutes = isFastTransfer ? 5 : 20;
  throw new Error(
    `Attestation timeout after ${timeoutMinutes} minutes. Check: ${ATTESTATION_API_URL}?transactionHash=${txHash}`,
  );
}

// ============================================================================
// Step 3: Create Solana receiveMessage Transaction
// ============================================================================

async function createSolanaReceiveMessageTx(
  message: string,
  attestation: string
): Promise<string> {
  console.log("=== Step 3: Creating Solana receiveMessage Transaction ===\n");

  const connection = new Connection(
    bridgeConfigSolana.solanaRpcUrl,
    "confirmed",
  );
  const recipientPubkey = new PublicKey(
    bridgeConfigSolana.solanaRecipientAddress,
  );

  // Initialize Anchor provider and programs
  // Create a custom Anchor provider using our Solana RPC URL
  const anchorProvider = new anchor.AnchorProvider(
    connection,
    { publicKey: recipientPubkey } as any, // Mock wallet - we only need it for reading data
    { commitment: "confirmed" }
  );
  const { messageTransmitterProgram, tokenMessengerMinterProgram } =
    getProgramsV2(anchorProvider);

  const usdcAddress = SOLANA_USDC_MINT;
  // Derive the ATA for the recipient's USDC account
  const userTokenAccount = await getAssociatedTokenAddress(
    usdcAddress,
    recipientPubkey
  );
  const remoteTokenAddressHex = ARBITRUM_USDC;
  const remoteDomain = ARBITRUM_DOMAIN.toString();
  const messageHex = message;
  const attestationHex = attestation;
  const nonce = decodeEventNonceFromMessageV2(messageHex);

  // Get PDAs
  const pdas = await getReceiveMessagePdasV2(
    { messageTransmitterProgram, tokenMessengerMinterProgram },
    usdcAddress,
    remoteTokenAddressHex,
    remoteDomain,
    nonce
  );

  // accountMetas list to pass to remainingAccounts
  const accountMetas: any[] = [];
  accountMetas.push({
    isSigner: false,
    isWritable: false,
    pubkey: pdas.tokenMessengerAccount.publicKey,
  });
  accountMetas.push({
    isSigner: false,
    isWritable: false,
    pubkey: pdas.remoteTokenMessengerKey.publicKey,
  });
  accountMetas.push({
    isSigner: false,
    isWritable: true,
    pubkey: pdas.tokenMinterAccount.publicKey,
  });
  accountMetas.push({
    isSigner: false,
    isWritable: true,
    pubkey: pdas.localToken.publicKey,
  });
  accountMetas.push({
    isSigner: false,
    isWritable: false,
    pubkey: pdas.tokenPair.publicKey,
  });
  accountMetas.push({
    isSigner: false,
    isWritable: true,
    pubkey: pdas.feeRecipientTokenAccount,
  });
  accountMetas.push({
    isSigner: false,
    isWritable: true,
    pubkey: userTokenAccount,
  });
  accountMetas.push({
    isSigner: false,
    isWritable: true,
    pubkey: pdas.custodyTokenAccount.publicKey,
  });
  accountMetas.push({
    isSigner: false,
    isWritable: false,
    pubkey: TOKEN_PROGRAM_ID,
  });
  accountMetas.push({
    isSigner: false,
    isWritable: false,
    pubkey: pdas.tokenMessengerEventAuthority.publicKey,
  });
  accountMetas.push({
    isSigner: false,
    isWritable: false,
    pubkey: tokenMessengerMinterProgram.programId,
  });

  // Build the receiveMessage instruction using the Anchor program
  const instructionBuilder = messageTransmitterProgram.methods
    .receiveMessage({
      message: Buffer.from(messageHex.replace("0x", ""), "hex"),
      attestation: Buffer.from(attestationHex.replace("0x", ""), "hex"),
    })
    .accounts({
      payer: recipientPubkey,
      caller: recipientPubkey,
      messageTransmitter: pdas.messageTransmitterAccount.publicKey,
      usedNonce: pdas.usedNonce,
      receiver: tokenMessengerMinterProgram.programId,
    } as any)
    .remainingAccounts(accountMetas);

  const instruction = await instructionBuilder.instruction();

  // Get recent blockhash
  const { blockhash } = await connection.getLatestBlockhash();

  // Create VersionedTransaction with the instruction
  const instructions: TransactionInstruction[] = [];
  instructions.push(instruction);

  const txMessage = new TransactionMessage({
    payerKey: recipientPubkey,
    recentBlockhash: blockhash,
    instructions: instructions,
  }).compileToV0Message();

  const transaction = new VersionedTransaction(txMessage);
  const serializedTx = transaction.message.serialize();
  const base64EncodedData = Buffer.from(serializedTx).toString("base64");

  console.log(`Transaction size: ${serializedTx.length} bytes`);

  return base64EncodedData;
}

// ============================================================================
// Step 4: Submit to Fordefi API
// ============================================================================

async function submitToFordefiApi(base64SerializedTx: string): Promise<void> {
  console.log("=== Step 4: Submitting to Fordefi API ===\n");

  const fordefiApiPayload = {
    vault_id: bridgeConfigSolana.fordefiVaultId,
    signer_type: "api_signer",
    sign_mode: "auto",
    type: "solana_transaction",
    details: {
      type: "solana_serialized_transaction_message",
      push_mode: "auto",
      chain: "solana_mainnet",
      data: base64SerializedTx
    },
  };

  const requestBody = JSON.stringify(fordefiApiPayload);
  const timestamp = new Date().getTime();
  const payload = `${"/api/v1/transactions"}|${timestamp}|${requestBody}`;

  const signature = await signWithApiSigner(payload, bridgeConfigSolana.apiPayloadSignKey);
  const response = await createAndSignTx("/api/v1/transactions", bridgeConfigSolana.apiUserToken, signature, timestamp, requestBody);

  console.log("Response:", response.data);
}

// ============================================================================
// Main Function
// ============================================================================

async function main(): Promise<void> {
  try {
    console.log("=== EVM → Solana CCTP Bridge ===\n");

    if (!bridgeConfigSolana.solanaRecipientAddress) {
      throw new Error("SOLANA_RECIPIENT_ADDRESS must be set");
    }
    if (!bridgeConfigSolana.fordefiVaultId) {
      throw new Error("FORDEFI_SOLANA_VAULT_ID must be set");
    }

    const { txHash, message } = await burnUsdcOnEthereum();
    const { attestation } = await waitForAttestation(txHash);
    const base64SerializedTx = await createSolanaReceiveMessageTx(
      message,
      attestation
    );
    await submitToFordefiApi(base64SerializedTx);

    console.log("\n✅ Bridge completed\n");
  } catch (error) {
    console.error("\n❌ Error:", error);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
