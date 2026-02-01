import { getTargetNetworks } from "./networks";

export function getBlockExplorerAddressLink(chain: any, address: string) {
  return `${chain.blockExplorers?.default?.url}/address/${address}`;
}