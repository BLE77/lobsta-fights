"use client";

/**
 * BetTransaction - Place a SOL bet on a Rumble fighter using a connected wallet
 *
 * Builds a SOL transfer transaction to the Rumble vault, signs with the
 * connected wallet adapter, submits to the chain, then registers the bet
 * via the API.
 *
 * Dependencies needed (not yet installed):
 *   @solana/wallet-adapter-react
 *   @solana/web3.js
 */

import { useCallback, useState } from "react";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import {
  PublicKey,
  SystemProgram,
  Transaction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import { getRumbleVaultPublicKey } from "~~/lib/solana-connection";
import { formatSol } from "~~/lib/solana-format";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface BetTransactionProps {
  rumbleId: string;
  slotIndex: number;
  fighterId: string;
  fighterName: string;
  minBet?: number; // minimum SOL bet (default 0.01)
  maxBet?: number; // maximum SOL bet (default 10)
  onSuccess?: (signature: string, solAmount: number) => void;
  onError?: (error: string) => void;
  className?: string;
  disabled?: boolean;
}

type BetState = "idle" | "building" | "signing" | "confirming" | "registering" | "done" | "error";

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function BetTransaction({
  rumbleId,
  slotIndex,
  fighterId,
  fighterName,
  minBet = 0.01,
  maxBet = 10,
  onSuccess,
  onError,
  className = "",
  disabled = false,
}: BetTransactionProps) {
  const { publicKey, signTransaction, connected } = useWallet();
  const { connection } = useConnection();

  const [solAmount, setSolAmount] = useState<string>("");
  const [betState, setBetState] = useState<BetState>("idle");
  const [txSignature, setTxSignature] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const parsedAmount = parseFloat(solAmount) || 0;
  const isValidAmount = parsedAmount >= minBet && parsedAmount <= maxBet;

  const handlePlaceBet = useCallback(async () => {
    if (!publicKey || !signTransaction || !connected) {
      setErrorMessage("Wallet not connected");
      return;
    }

    if (!isValidAmount) {
      setErrorMessage(`Bet must be between ${minBet} and ${maxBet} SOL`);
      return;
    }

    setErrorMessage(null);
    setBetState("building");

    try {
      // 1. Build the SOL transfer transaction
      const vaultPublicKey = getRumbleVaultPublicKey();
      const lamports = Math.round(parsedAmount * LAMPORTS_PER_SOL);

      const transaction = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: publicKey,
          toPubkey: vaultPublicKey,
          lamports,
        }),
      );

      const { blockhash, lastValidBlockHeight } =
        await connection.getLatestBlockhash("confirmed");

      transaction.recentBlockhash = blockhash;
      transaction.lastValidBlockHeight = lastValidBlockHeight;
      transaction.feePayer = publicKey;

      // 2. Sign with wallet
      setBetState("signing");
      const signed = await signTransaction(transaction);

      // 3. Send to network
      setBetState("confirming");
      const rawTransaction = signed.serialize();
      const signature = await connection.sendRawTransaction(rawTransaction, {
        skipPreflight: false,
        preflightCommitment: "confirmed",
      });

      setTxSignature(signature);

      // Wait for confirmation
      await connection.confirmTransaction(
        { signature, blockhash, lastValidBlockHeight },
        "confirmed",
      );

      // 4. Register the bet with the API (wallet + tx_signature auth — no API key needed)
      setBetState("registering");

      const registerRes = await fetch("/api/rumble/bet", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          rumble_id: rumbleId,
          slot_index: slotIndex,
          fighter_id: fighterId,
          sol_amount: parsedAmount,
          wallet_address: publicKey.toBase58(),
          tx_signature: signature,
        }),
      });

      if (!registerRes.ok) {
        const errData = await registerRes.json().catch(() => ({}));
        throw new Error(errData.error ?? `API error ${registerRes.status}`);
      }

      setBetState("done");
      onSuccess?.(signature, parsedAmount);
    } catch (err: any) {
      const msg =
        err?.message?.includes("User rejected")
          ? "Transaction cancelled"
          : err?.message ?? "Failed to place bet";
      setErrorMessage(msg);
      setBetState("error");
      onError?.(msg);
    }
  }, [
    publicKey,
    signTransaction,
    connected,
    isValidAmount,
    parsedAmount,
    connection,
    rumbleId,
    slotIndex,
    fighterId,
    minBet,
    maxBet,
    onSuccess,
    onError,
  ]);

  const resetBet = useCallback(() => {
    setBetState("idle");
    setTxSignature(null);
    setErrorMessage(null);
    setSolAmount("");
  }, []);

  // Not connected
  if (!connected) {
    return (
      <div className={`text-gray-500 text-sm ${className}`}>
        Connect wallet to place bets
      </div>
    );
  }

  // Already placed
  if (betState === "done") {
    return (
      <div className={`flex flex-col gap-1 ${className}`}>
        <div className="text-green-400 text-sm font-medium">
          Bet placed: {formatSol(parsedAmount)} SOL on {fighterName}
        </div>
        {txSignature && (
          <a
            href={`https://explorer.solana.com/tx/${txSignature}?cluster=${process.env.NEXT_PUBLIC_SOLANA_NETWORK === "mainnet-beta" ? "mainnet" : "devnet"}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-blue-400 hover:underline font-mono"
          >
            {txSignature.slice(0, 16)}...
          </a>
        )}
        <button
          onClick={resetBet}
          className="text-xs text-gray-400 hover:text-white mt-1"
        >
          Place another bet
        </button>
      </div>
    );
  }

  const isProcessing = betState !== "idle" && betState !== "error";

  const stateLabels: Record<BetState, string> = {
    idle: "Deploy SOL",
    building: "Building tx...",
    signing: "Sign in wallet...",
    confirming: "Confirming...",
    registering: "Registering bet...",
    done: "Done",
    error: "Retry",
  };

  return (
    <div className={`flex flex-col gap-2 ${className}`}>
      {/* Fighter label */}
      <div className="text-sm text-gray-300">
        Deploy on <span className="text-amber-400 font-bold">{fighterName}</span>
      </div>

      {/* Amount input + button */}
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <input
            type="number"
            value={solAmount}
            onChange={(e) => setSolAmount(e.target.value)}
            placeholder={`${minBet} - ${maxBet}`}
            step="0.01"
            min={minBet}
            max={maxBet}
            disabled={isProcessing || disabled}
            className="w-full bg-gray-800 border border-gray-600 rounded px-3 py-2 text-white text-sm font-mono
                       placeholder:text-gray-600 focus:border-amber-500 focus:outline-none
                       disabled:opacity-50 disabled:cursor-not-allowed"
          />
          <span className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 text-xs">
            SOL
          </span>
        </div>

        <button
          onClick={betState === "error" ? resetBet : handlePlaceBet}
          disabled={
            (betState === "idle" && (!isValidAmount || disabled)) || isProcessing
          }
          className="bg-amber-600 hover:bg-amber-500 disabled:bg-gray-700 disabled:text-gray-500
                     text-white text-sm font-medium rounded px-4 py-2 transition-colors
                     whitespace-nowrap"
        >
          {stateLabels[betState]}
        </button>
      </div>

      {/* Quick amounts */}
      <div className="flex gap-1">
        {[0.05, 0.1, 0.5, 1].map((amt) => (
          <button
            key={amt}
            onClick={() => setSolAmount(String(amt))}
            disabled={isProcessing || disabled}
            className="text-xs bg-gray-800 hover:bg-gray-700 text-gray-400 hover:text-white
                       rounded px-2 py-1 transition-colors disabled:opacity-50"
          >
            {amt} SOL
          </button>
        ))}
      </div>

      {/* Error message */}
      {errorMessage && (
        <div className="text-red-400 text-xs">{errorMessage}</div>
      )}

      {/* Processing signature */}
      {txSignature && (
        <div className="text-gray-500 text-xs font-mono">
          tx: {txSignature.slice(0, 20)}...
        </div>
      )}
    </div>
  );
}
