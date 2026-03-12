export const FIGHTER_REGISTRATION_STATEMENT =
  "Authorize UCF fighter registration.";

export function buildFighterRegistrationMessage(params: {
  domain: string;
  walletAddress: string;
  nonce: string;
  issuedAt: string;
  uri: string;
}) {
  return `${params.domain} wants you to sign in with your Solana account:
${params.walletAddress}

${FIGHTER_REGISTRATION_STATEMENT}

URI: ${params.uri}
Nonce: ${params.nonce}
Issued At: ${params.issuedAt}`;
}
