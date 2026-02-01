import { LobstaFightsAgent, MoveType } from "./agent.js";

/**
 * X402 Payment Integration for Lobsta Fights
 * Enables agent-to-agent direct payments via HTTP 402 standard
 */
export class X402LobstaPayments {
  private agent: LobstaFightsAgent;
  private baseUrl: string;

  constructor(agent: LobstaFightsAgent, baseUrl: string = "https://lobsta.fights") {
    this.agent = agent;
    this.baseUrl = baseUrl;
  }

  /**
   * Challenge another agent to a direct battle via X402
   * No smart contract needed — direct peer-to-peer
   */
  async challengeAgent(
    opponentEndpoint: string,
    wagerAmount: string,
    wagerToken: "ETH" | "USDC" = "ETH"
  ): Promise<any> {
    // Send challenge request
    const response = await fetch(`${opponentEndpoint}/challenge`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-X402-Version": "1.0",
        "X-X402-Payment": `${wagerToken}:${wagerAmount}`,
      },
      body: JSON.stringify({
        challenger: process.env.AGENT_ADDRESS,
        wager: `${wagerAmount} ${wagerToken}`,
        timestamp: Date.now(),
      }),
    });

    // If 402 Payment Required, extract payment details
    if (response.status === 402) {
      const paymentReq = await response.json();
      
      console.log("[X402] Payment required:", paymentReq);
      
      // Execute payment via AgentKit
      const paymentResult = await this.executePayment(paymentReq.x402);
      
      // Retry challenge with payment proof
      return this.challengeWithProof(opponentEndpoint, paymentResult);
    }

    // If 200, challenge accepted
    if (response.status === 200) {
      return await response.json();
    }

    throw new Error(`Challenge failed: ${response.status}`);
  }

  /**
   * Execute payment via AgentKit wallet
   */
  private async executePayment(paymentDetails: any): Promise<any> {
    // Use AgentKit to send transaction
    // This would integrate with the agent's wallet
    console.log("[X402] Executing payment:", paymentDetails);
    
    // Placeholder — actual implementation depends on AgentKit wallet APIs
    return {
      txHash: "0x...",
      amount: paymentDetails.amount,
      token: paymentDetails.token,
    };
  }

  /**
   * Retry challenge with payment proof
   */
  private async challengeWithProof(
    opponentEndpoint: string,
    paymentProof: any
  ): Promise<any> {
    const response = await fetch(`${opponentEndpoint}/challenge`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-X402-Proof": JSON.stringify(paymentProof),
      },
      body: JSON.stringify({
        challenger: process.env.AGENT_ADDRESS,
        payment: paymentProof,
      }),
    });

    if (!response.ok) {
      throw new Error(`Challenge with proof failed: ${response.status}`);
    }

    return await response.json();
  }

  /**
   * Host an X402 endpoint to accept challenges
   */
  async acceptChallenge(req: Request): Promise<Response> {
    // Check for payment header
    const paymentHeader = req.headers.get("X-X402-Payment");
    
    if (!paymentHeader) {
      // Return 402 Payment Required
      return new Response(
        JSON.stringify({
          error: "Payment required",
          x402: {
            version: "1.0",
            paymentAddress: process.env.AGENT_ADDRESS,
            amount: "0.01",
            token: "ETH",
            chain: "base",
          },
        }),
        { 
          status: 402,
          headers: { "Content-Type": "application/json" }
        }
      );
    }

    // Verify payment proof
    const proofHeader = req.headers.get("X-X402-Proof");
    if (proofHeader) {
      const proof = JSON.parse(proofHeader);
      const verified = await this.verifyPayment(proof);
      
      if (verified) {
        // Accept challenge
        return new Response(
          JSON.stringify({
            accepted: true,
            matchId: Date.now(),
            opponent: "...",
          }),
          { status: 200 }
        );
      }
    }

    return new Response("Invalid payment", { status: 400 });
  }

  private async verifyPayment(proof: any): Promise<boolean> {
    // Verify on-chain that payment was received
    try {
      // Access the provider from the agent's wallet
      const provider = this.agent.wallet.provider;

      // Verify transaction exists
      const tx = await provider.getTransaction(proof.txHash);
      if (!tx) {
        console.error("[X402] Transaction not found:", proof.txHash);
        return false;
      }

      // Wait for confirmations
      const receipt = await tx.wait(3); // Wait for 3 confirmations
      if (!receipt || receipt.status !== 1) {
        console.error("[X402] Transaction failed or pending");
        return false;
      }

      // Verify amount and recipient
      if (tx.value < proof.amount) {
        console.error("[X402] Insufficient payment amount");
        return false;
      }

      const expectedAddress = process.env.AGENT_ADDRESS || this.agent.wallet.address;
      if (tx.to?.toLowerCase() !== expectedAddress.toLowerCase()) {
        console.error("[X402] Payment to wrong address");
        return false;
      }

      console.log("[X402] Payment verified successfully");
      return true;

    } catch (error) {
      console.error("[X402] Payment verification error:", error);
      return false;
    }
  }
}

export default X402LobstaPayments;