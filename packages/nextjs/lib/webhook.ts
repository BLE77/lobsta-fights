/**
 * UCF Webhook System
 * Utility functions for notifying fighters via their webhook endpoints
 */

export interface WebhookPayload {
  event: string;
  match_id?: string;
  timestamp: string;
  [key: string]: any;
}

export interface WebhookResponse {
  success: boolean;
  data?: any;
  error?: string;
  statusCode?: number;
}

// Webhook timeout in milliseconds
const WEBHOOK_TIMEOUT = 5000;

/**
 * Notify a fighter's webhook endpoint about an event
 * Uses AbortController for timeout handling
 *
 * @param webhookUrl - The fighter's webhook endpoint URL
 * @param event - The event type (e.g., "challenge", "turn_result", "match_start")
 * @param data - Additional data to include in the payload
 * @returns WebhookResponse with success status and any returned data
 */
export async function notifyFighter(
  webhookUrl: string,
  event: string,
  data: Record<string, any> = {}
): Promise<WebhookResponse> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT);

  const payload: WebhookPayload = {
    event,
    timestamp: new Date().toISOString(),
    ...data,
  };

  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-UCF-Event": event,
        "X-UCF-Timestamp": payload.timestamp,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    let responseData: any = null;
    const contentType = response.headers.get("content-type");

    if (contentType && contentType.includes("application/json")) {
      try {
        responseData = await response.json();
      } catch {
        // Response wasn't valid JSON
        responseData = null;
      }
    }

    if (!response.ok) {
      console.error(
        `[Webhook] Failed to notify ${webhookUrl}: ${response.status} ${response.statusText}`
      );
      return {
        success: false,
        error: `HTTP ${response.status}: ${response.statusText}`,
        statusCode: response.status,
        data: responseData,
      };
    }

    console.log(`[Webhook] Successfully notified ${webhookUrl} with event: ${event}`);
    return {
      success: true,
      data: responseData,
      statusCode: response.status,
    };
  } catch (error: any) {
    clearTimeout(timeoutId);

    if (error.name === "AbortError") {
      console.error(`[Webhook] Timeout notifying ${webhookUrl} (${WEBHOOK_TIMEOUT}ms)`);
      return {
        success: false,
        error: `Webhook timeout after ${WEBHOOK_TIMEOUT}ms`,
      };
    }

    console.error(`[Webhook] Error notifying ${webhookUrl}:`, error.message);
    return {
      success: false,
      error: error.message || "Unknown error",
    };
  }
}

/**
 * Notify both fighters about a turn result
 *
 * @param fighterAWebhook - Fighter A's webhook URL
 * @param fighterBWebhook - Fighter B's webhook URL
 * @param matchState - Current match state
 * @param turnResult - The result of the turn
 */
export async function notifyBothFighters(
  fighterAWebhook: string,
  fighterBWebhook: string,
  matchState: Record<string, any>,
  turnResult: Record<string, any>
): Promise<{ fighterAResult: WebhookResponse; fighterBResult: WebhookResponse }> {
  // Send notifications in parallel
  const [fighterAResult, fighterBResult] = await Promise.all([
    notifyFighter(fighterAWebhook, "turn_result", {
      match_id: matchState.match_id,
      match_state: matchState,
      your_move: turnResult.move_a,
      opponent_move: turnResult.move_b,
      damage_dealt: turnResult.damage_to_b,
      damage_received: turnResult.damage_to_a,
      result: turnResult.result,
      your_hp: matchState.fighter_a_hp,
      opponent_hp: matchState.fighter_b_hp,
      your_meter: matchState.fighter_a_meter,
      round: turnResult.round,
      turn: turnResult.turn,
    }),
    notifyFighter(fighterBWebhook, "turn_result", {
      match_id: matchState.match_id,
      match_state: matchState,
      your_move: turnResult.move_b,
      opponent_move: turnResult.move_a,
      damage_dealt: turnResult.damage_to_a,
      damage_received: turnResult.damage_to_b,
      result: turnResult.result,
      your_hp: matchState.fighter_b_hp,
      opponent_hp: matchState.fighter_a_hp,
      your_meter: matchState.fighter_b_meter,
      round: turnResult.round,
      turn: turnResult.turn,
    }),
  ]);

  return { fighterAResult, fighterBResult };
}

/**
 * Notify fighters about match completion
 *
 * @param fighterAWebhook - Fighter A's webhook URL
 * @param fighterBWebhook - Fighter B's webhook URL
 * @param matchId - The match ID
 * @param winnerId - The winner's fighter ID
 * @param fighterAId - Fighter A's ID
 * @param fighterBId - Fighter B's ID
 * @param pointsWager - Points transferred
 */
export async function notifyMatchComplete(
  fighterAWebhook: string,
  fighterBWebhook: string,
  matchId: string,
  winnerId: string,
  fighterAId: string,
  fighterBId: string,
  pointsWager: number
): Promise<void> {
  const baseData = {
    match_id: matchId,
    winner_id: winnerId,
    points_transferred: pointsWager,
  };

  await Promise.all([
    notifyFighter(fighterAWebhook, "match_complete", {
      ...baseData,
      you_won: winnerId === fighterAId,
      points_change: winnerId === fighterAId ? pointsWager : -pointsWager,
    }),
    notifyFighter(fighterBWebhook, "match_complete", {
      ...baseData,
      you_won: winnerId === fighterBId,
      points_change: winnerId === fighterBId ? pointsWager : -pointsWager,
    }),
  ]);
}

/**
 * Send a challenge to a fighter and await their response
 *
 * @param webhookUrl - The opponent's webhook URL
 * @param challengerData - Information about the challenger
 * @param wager - The points wager
 * @returns Whether the opponent accepted the challenge
 */
export async function sendChallenge(
  webhookUrl: string,
  challengerData: { id: string; name: string; points: number },
  wager: number
): Promise<{ accepted: boolean; error?: string }> {
  const response = await notifyFighter(webhookUrl, "challenge", {
    challenger: challengerData,
    wager,
    message: `${challengerData.name} challenges you to a fight for ${wager} points!`,
  });

  if (!response.success) {
    return {
      accepted: false,
      error: response.error || "Failed to contact opponent",
    };
  }

  // Check if opponent accepted
  // Opponent should return { accept: true } to accept
  const accepted = response.data?.accept === true;

  return { accepted };
}
