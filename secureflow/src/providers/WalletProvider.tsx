import React from "react";
import { WagmiProvider } from "wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createAppKit } from "@reown/appkit/react";
import { WagmiAdapter } from "@reown/appkit-adapter-wagmi";
import { defineChain } from "viem";
import type { AppKitNetwork } from "@reown/appkit/networks";

// ─── Arc Testnet — defined as a viem Chain ────────────────────────────────────
export const arcTestnet = defineChain({
  id: 5042002,
  name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 6 },
  rpcUrls: {
    default: { http: ["https://rpc.drpc.testnet.arc.network"] },
  },
  blockExplorers: {
    default: { name: "ArcScan", url: "https://testnet.arcscan.app" },
  },
  testnet: true,
});

// Cast to Reown's AppKitNetwork so it works with createAppKit and WagmiAdapter
const arcTestnetReown = arcTestnet as unknown as AppKitNetwork;

const projectId = (import.meta.env.VITE_REOWN_PROJECT_ID as string | undefined) ?? "";

// ─── Wagmi adapter (Reown manages connectors: MetaMask, WC QR, Coinbase, etc.)
export const wagmiAdapter = new WagmiAdapter({
  projectId,
  networks: [arcTestnetReown],
});

export const wagmiConfig = wagmiAdapter.wagmiConfig;

// ─── Reown AppKit initialisation ──────────────────────────────────────────────
createAppKit({
  adapters: [wagmiAdapter],
  projectId,
  networks: [arcTestnetReown],
  defaultNetwork: arcTestnetReown,
  metadata: {
    name: "SecureFlow",
    description: "Milestone-based freelancer escrow on Arc EVM",
    url: typeof window !== "undefined" ? window.location.origin : "https://secureflow.app",
    icons: ["/favicon.ico"],
  },
  features: {
    analytics: false,
    email: false,
    socials: [],
  },
  themeMode: "dark",
  themeVariables: {
    "--w3m-accent": "#7D00FF",
    "--w3m-border-radius-master": "8px",
  },
});

const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false, retry: false } },
});

export const WalletProvider = ({ children }: { children: React.ReactNode }) => (
  <WagmiProvider config={wagmiConfig}>
    <QueryClientProvider client={queryClient}>
      {children}
    </QueryClientProvider>
  </WagmiProvider>
);
