/**
 * Shared type definitions for the UCF mobile-native app.
 * Extracted from App.tsx monolith — see App.tsx header comment for details.
 */

export type NonceResponse = {
  nonce: string;
  issuedAt: string;
  expiresAt: string;
};

export type VerifyResponse = {
  ok: boolean;
  walletAddress: string;
  domain: string;
};

export type RumbleSlotFighter = {
  id?: string;
  fighterId?: string;
  name?: string;
  hp?: number;
  maxHp?: number;
  imageUrl?: string | null;
  totalDamageDealt?: number;
  placement?: number;
};

export type RumbleTurnPairing = {
  fighterA?: string;
  fighterB?: string;
  fighterAName?: string;
  fighterBName?: string;
  damageToA?: number;
  damageToB?: number;
  moveA?: string;
  moveB?: string;
};

export type RumbleTurn = {
  turnNumber?: number;
  pairings?: RumbleTurnPairing[];
  eliminations?: string[];
  bye?: string;
};

export type RumbleSlotOdds = {
  fighterId?: string;
  fighterName?: string;
  imageUrl?: string | null;
  hp?: number;
  solDeployed?: number;
  betCount?: number;
  impliedProbability?: number;
  potentialReturn?: number;
};

export type SlotPayout = {
  winnerBettorsPayout?: number;
  placeBettorsPayout?: number;
  showBettorsPayout?: number;
  treasuryVault?: number;
  totalPool?: number;
  ichorMined?: number;
  ichorShowerTriggered?: boolean;
  ichorShowerAmount?: number;
};

export type CommentaryClip = {
  clipKey?: string;
  text?: string;
  audioUrl?: string | null;
  eventType?: string;
  createdAt?: number | string;
};

export type RumbleSlot = {
  slotIndex?: number;
  rumbleId?: string;
  rumbleNumber?: number | null;
  state?: "idle" | "betting" | "combat" | "payout";
  turnPhase?: string | null;
  fighters?: RumbleSlotFighter[];
  odds?: RumbleSlotOdds[];
  totalPool?: number;
  bettingDeadline?: string | null;
  nextTurnAt?: string | null;
  currentTurn?: number;
  remainingFighters?: number | null;
  turns?: RumbleTurn[];
  fighterNames?: Record<string, string>;
  payout?: SlotPayout | null;
  commentary?: CommentaryClip[];
};

export type QueueFighter = {
  fighterId?: string;
  name?: string;
  imageUrl?: string | null;
  position?: number;
};

export type RumbleStatusResponse = {
  slots?: RumbleSlot[];
  queue?: QueueFighter[];
  queueLength?: number;
  nextRumbleIn?: string | null;
  bettingCloseGuardMs?: number;
  ichorShower?: {
    currentPool?: number;
    rumblesSinceLastTrigger?: number;
  };
};

export type ClaimBalanceResponse = {
  payout_mode?: "instant" | "accrue_claim";
  claimable_sol?: number;
  claimed_sol?: number;
  onchain_pending_not_ready_sol?: number;
  onchain_claim_ready?: boolean;
  pending_rumbles?: Array<{
    rumble_id?: string;
    claimable_sol?: number;
    claim_method?: "onchain" | "offchain";
    onchain_payout_ready?: boolean;
  }>;
};

export type ChatMessage = {
  id: string;
  user_id: string;
  username: string;
  message: string;
  created_at: string;
};

export type TxEntry = {
  signature: string;
  blockTime: number | null;
  confirmationStatus: string | null;
  err: boolean;
};

export type TabKey = "arena" | "chat" | "queue" | "setup";

export type FighterSetupStatus = {
  fighter: {
    id?: string;
    name?: string;
    verified?: boolean;
    createdAt?: string | null;
    created_at?: string | null;
  } | null;
  trust?: {
    approved?: boolean;
    source?: string | null;
    label?: string | null;
    reason?: string | null;
    sgtAssetId?: string | null;
  } | null;
  delegate?: {
    configured?: boolean;
    authorized?: boolean;
    revoked?: boolean;
    expectedAuthority?: string | null;
    onchainAuthority?: string | null;
    matchesExpectedAuthority?: boolean;
    nextAction?: "authorize_delegate" | "rebind_delegate" | "ready_for_seekerclaw";
    message?: string;
  } | null;
  can_register?: boolean;
  can_queue?: boolean;
  can_auto_verify_existing_fighter?: boolean;
  canRegister?: boolean;
  canQueue?: boolean;
  canAutoVerifyExistingFighter?: boolean;
  next_action?: string | null;
  nextAction?: string | null;
  message?: string | null;
};

export type MyBetsResponse = {
  slots?: Array<{
    slot_index?: number;
    rumble_id?: string;
    bets?: Array<{
      fighter_id?: string;
      sol_amount?: number;
    }>;
  }>;
};

export type PrepareBetLeg = {
  fighter_id: string;
  fighter_index?: number;
  sol_amount: number;
};

export type PrepareBetResponse = {
  slot_index?: number;
  rumble_id?: string;
  rumble_id_num?: number;
  tx_kind?: string;
  transaction_base64: string;
  bets?: PrepareBetLeg[];
  guard_ms?: number;
  guard_slots?: number;
  onchain_betting_close_slot?: string | number | null;
  onchain_betting_deadline?: string | null;
};
