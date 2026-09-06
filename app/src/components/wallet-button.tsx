/**
 * The wallet control.
 *
 * This used to be a hand-built dropdown: copy address, refresh balance,
 * disconnect. Reown's AppKit is already initialised for connecting, and its
 * account modal does all three plus network switching, balance, transaction
 * history and the wallet's own branding — so the custom menu was a worse copy of
 * something already paid for, and one that had to be maintained separately every
 * time the wallet layer changed.
 *
 * Now the button is just a button. Reown owns everything behind it.
 *
 * What is kept is the trigger's own content — network, balance and address —
 * because that is the piece Reown does not render for you, and a wallet control
 * that shows nothing until you click it makes people click it to check they are
 * still connected.
 */

import { Button } from "@/components/ui/button";
import { useWeb3 } from "@/contexts/web3-context";
import { useState } from "react";
import { useAppKit } from "@reown/appkit/react";
import { Link } from "react-router-dom";
import { useManagedWorker } from "@/hooks/use-managed-worker";

export function WalletButton() {
  const { wallet, connectWallet } = useWeb3();
  const [networkIconError, setNetworkIconError] = useState(false);
  const [walletIconError, setWalletIconError] = useState(false);
  const { open } = useAppKit();
  const managedWorker = useManagedWorker();

  /*
   * A managed worker is signed in without a wallet, and telling them to
   * "Connect Wallet" is both wrong and slightly insulting — the entire point of
   * their account is that they never had to. Show the Circle MPC address they
   * actually have, and send them to their own page rather than a wallet modal.
   */
  if (!wallet.isConnected || !wallet.address) {
    if (managedWorker) {
      return (
        <Button
          asChild
          variant="secondary"
          className="actor-human font-mono flex items-center gap-2 px-2.5 sm:px-3 md:px-4 bg-muted/50 hover:bg-muted/70 border border-border/40 max-w-[170px] sm:max-w-none"
        >
          <Link to="/get-hired" title={managedWorker.address}>
            <span className="actor-dot shrink-0" aria-hidden="true" />
            <span className="hidden lg:inline tabular-nums">
              {Number(managedWorker.balance ?? 0).toFixed(2)} USDC
            </span>
            <span className="hidden lg:inline text-muted-foreground" aria-hidden="true">
              ·
            </span>
            <span className="truncate">
              {managedWorker.address.slice(0, 6)}…{managedWorker.address.slice(-4)}
            </span>
          </Link>
        </Button>
      );
    }

    return (
      <Button onClick={() => void connectWallet()} variant="default">
        <span className="hidden sm:inline">Connect Wallet</span>
        <span className="sm:hidden">Connect</span>
      </Button>
    );
  }

  const short = `${wallet.address.slice(0, 6)}…${wallet.address.slice(-4)}`;

  return (
    <Button
      variant="secondary"
      onClick={() => void open({ view: "Account" })}
      aria-label={`Wallet ${short} — open account`}
      className="font-mono flex items-center gap-2 px-2.5 sm:px-3 md:px-4 bg-muted/50 hover:bg-muted/70 border border-border/40 max-w-[150px] sm:max-w-none"
    >
      {/* Network + balance are desktop-only: on a phone the address alone has to
          fit beside the menu button, and truncating everything to make room for
          a 4px network dot helps nobody. */}
      <span className="hidden lg:flex items-center gap-2">
        <span className="w-4 h-4 rounded-full overflow-hidden flex items-center justify-center shrink-0">
          {!networkIconError ? (
            <img
              src="/arc-icon.svg"
              alt=""
              aria-hidden="true"
              className="w-full h-full object-contain"
              onError={() => setNetworkIconError(true)}
            />
          ) : (
            <span className="w-full h-full rounded-full bg-primary" />
          )}
        </span>

        <span className="tabular-nums">
          {Number(wallet.balance || 0).toFixed(2)} USDC
        </span>
        <span className="text-muted-foreground" aria-hidden="true">
          ·
        </span>
      </span>

      <span className="w-4 h-4 rounded-full overflow-hidden shrink-0">
        {!walletIconError ? (
          <img
            src={`https://effigy.im/a/${wallet.address}.svg`}
            alt=""
            aria-hidden="true"
            className="w-full h-full object-cover"
            onError={() => setWalletIconError(true)}
          />
        ) : (
          <span className="block w-full h-full bg-gradient-to-br from-primary to-accent rounded-full" />
        )}
      </span>

      <span className="truncate" title={wallet.address}>
        {short}
      </span>
    </Button>
  );
}
