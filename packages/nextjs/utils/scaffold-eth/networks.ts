export function getTargetNetworks() {
  return [
    {
      id: 84532,
      name: "Base Sepolia",
      network: "base-sepolia",
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: {
        default: { http: ["https://base-sepolia.g.alchemy.com/v2"] },
        public: { http: ["https://sepolia.base.org"] },
      },
      blockExplorers: {
        default: { name: "Basescan", url: "https://sepolia.basescan.org" },
      },
    },
  ];
}