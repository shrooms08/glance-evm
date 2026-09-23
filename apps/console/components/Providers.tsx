"use client";
import "@rainbow-me/rainbowkit/styles.css";

import { font, radius, themes } from "@glance/design";
import { darkTheme, lightTheme, RainbowKitProvider, type Theme } from "@rainbow-me/rainbowkit";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { WagmiProvider } from "wagmi";

import { ThemeProvider, useTheme } from "@/lib/theme";
import { wagmiConfig } from "@/lib/wagmi";

/** RainbowKit's wallet dialog, dressed in Glance's tokens. */
function walletTheme(name: "dark" | "light"): Theme {
  const t = themes[name];
  const base = (name === "dark" ? darkTheme : lightTheme)({ accentColor: t.primary, accentColorForeground: t.onPrimary, borderRadius: "large", overlayBlur: "small" });
  return {
    ...base,
    colors: {
      ...base.colors,
      modalBackground: t.surface,
      modalBorder: t.line,
      modalText: t.text,
      modalTextSecondary: t.mute,
      modalTextDim: t.mute,
      actionButtonSecondaryBackground: t.raised,
      generalBorder: t.line,
      menuItemBackground: t.raised,
      profileForeground: t.surface,
      closeButtonBackground: t.raised,
      closeButton: t.soft,
      error: t.fail,
    },
    fonts: { body: font.sans },
    radii: { ...base.radii, modal: `${radius.card}px`, actionButton: `${radius.pill}px`, connectButton: `${radius.pill}px`, menuButton: `${radius.lg}px` },
  };
}

function Wallets({ children }: { children: ReactNode }) {
  const { theme } = useTheme();
  return (
    <RainbowKitProvider theme={walletTheme(theme)} modalSize="compact" appInfo={{ appName: "Glance" }}>
      {children}
    </RainbowKitProvider>
  );
}

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: true, staleTime: 5_000 } } }));
  return (
    <ThemeProvider>
      <WagmiProvider config={wagmiConfig}>
        <QueryClientProvider client={queryClient}>
          <Wallets>{children}</Wallets>
        </QueryClientProvider>
      </WagmiProvider>
    </ThemeProvider>
  );
}
