import { toast } from "react-hot-toast";
import { getPublicClient } from "@wagmi/core";
import { getTargetNetworks } from "./networks";
import { contracts } from "./contracts";

export function getParsedError(error: any): string {
  let message = error?.message || error;

  if (message?.includes("User rejected")) {
    return "Transaction rejected by user";
  }

  if (message?.includes("insufficient funds")) {
    return "Insufficient funds for transaction";
  }

  return message;
}

export const notification = {
  success: (message: string) => toast.success(message),
  error: (message: string) => toast.error(message),
  info: (message: string) => toast(message),
  loading: (message: string) => toast.loading(message),
};

export { contracts, getPublicClient, getTargetNetworks };