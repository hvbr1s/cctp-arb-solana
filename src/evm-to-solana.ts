import "dotenv/config";
import { getProvider } from "./get-provider";
import {
  fordefiConfigFrom,
  bridgeConfigSolana,
  SOLANA_RELAYER_PRIVATE_KEY
} from "./config";
import { BridgeKit } from "@circle-fin/bridge-kit";
import { createAdapterFromProvider } from "@circle-fin/adapter-viem-v2";
import { createAdapterFromPrivateKey as createSolanaAdapterFromPrivateKey } from "@circle-fin/adapter-solana";

/**
 * EVM to Solana CCTP Bridge with Circle Bridge Kit
 *
 * This script demonstrates bridging USDC from any EVM chain to Solana using Circle's official SDK:
 * - Uses Fordefi provider for EVM side (secure signing)
 * - Uses simple private key for Solana side (relayer)
 * - Bridge Kit handles attestation and completion automatically
 */

// ============================================================================
// Bridge USDC from EVM to Solana using Circle Bridge Kit
// ============================================================================

async function bridgeUsdcEvmToSolana(): Promise<void> {
  console.log("=== EVM → Solana CCTP Bridge (Circle Bridge Kit) ===\n");

  // Initialize Fordefi provider for EVM
  const fordefiProvider = await getProvider(fordefiConfigFrom);
  if (!fordefiProvider) {
    throw new Error("Failed to initialize Fordefi provider");
  }

  // Get the from address for logging
  const fromAddress = await fordefiProvider.request({ method: "eth_accounts" }).then((accounts: any) => accounts[0]);

  console.log(`From: ${fromAddress}`);
  console.log(`To: ${bridgeConfigSolana.solanaRecipientAddress}`);
  console.log(`Amount: ${bridgeConfigSolana.amountUsdc} USDC\n`);

  // Initialize Bridge Kit
  const kit = new BridgeKit();

  // Create EVM adapter using Fordefi provider
  const viemAdapter = await createAdapterFromProvider({
    provider: fordefiProvider as any, // Fordefi provider is EIP1193-compatible
  });

  // Create Solana adapter from private key
  const solanaAdapter = createSolanaAdapterFromPrivateKey({
    privateKey: SOLANA_RELAYER_PRIVATE_KEY,
  });

  console.log("Starting bridge transfer...");
  console.log("This will:");
  console.log("1. Burn USDC on Arbitrum");
  console.log("2. Wait for Circle attestation");
  console.log("3. Mint USDC on Solana\n");

  // Execute the full bridge (burn + attestation + mint)
  const result = await kit.bridge({
    from: { adapter: viemAdapter, chain: "Arbitrum" },
    to: {
      adapter: solanaAdapter,
      chain: "Solana",
      recipientAddress: bridgeConfigSolana.solanaRecipientAddress // Explicitly set recipient
    },
    amount: bridgeConfigSolana.amountUsdc,
  });

  console.log("\n✅ Bridge completed successfully!");
  console.log("\nTransaction details:");

  // The result contains steps with transaction info
  if (result.steps && result.steps.length > 0) {
    const stepNames = [
      "Approve USDC (if needed)",
      "Burn USDC on Arbitrum",
      "Wait for attestation",
      "Mint USDC on Solana"
    ];

    result.steps.forEach((step: any, index: number) => {
      const stepName = stepNames[index] || `Step ${index + 1}`;
      console.log(`\n${stepName}:`);
      if (step.txHash) {
        console.log(`  Transaction: ${step.txHash}`);
      }
      if (step.explorerUrl) {
        console.log(`  Explorer: ${step.explorerUrl}`);
      }
    });
  }

  console.log("\n");
}

// ============================================================================
// Main Function
// ============================================================================

async function main(): Promise<void> {
  try {
    if (!bridgeConfigSolana.solanaRecipientAddress) {
      throw new Error("SOLANA_RECIPIENT_ADDRESS must be set");
    }

    await bridgeUsdcEvmToSolana();
  } catch (error) {
    console.error("\n❌ Error:", error);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
