/**
 * The wallet menu for someone signed in with a managed Circle wallet.
 *
 * A wallet user gets Reown's account modal — address, balance, copy, network,
 * disconnect. A managed worker got a button that did nothing when clicked,
 * which is worse than no button: it looks broken rather than absent.
 *
 * This is the same set of affordances, for an account whose keys we hold. The
 * one addition is that it keeps saying so, because the address in here is not
 * one the person can import into a wallet app and control.
 */

import { useState } from "react";
import { Link } from "react-router-dom";
import { Check, Copy, ExternalLink, LogOut, RefreshCw, Wallet } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { forgetWorker, type Worker } from "@/lib/atelier/worker";

const EXPLORER = (
  (import.meta.env.VITE_ARC_EXPLORER_URL as string | undefined) ??
  "https://testnet.arcscan.app"
)
  .trim()
  .replace(/\/$/, "");

export function ManagedWalletMenu({
  worker,
  onRefresh,
  refreshing,
  onSignOut,
}: {
  worker: Worker;
  onRefresh: () => void;
  refreshing: boolean;
  onSignOut: () => void;
}) {
  const { toast } = useToast();
  const [copied, setCopied] = useState(false);

  /**
   * `balance` is null when the daemon could not read it — an RPC hiccup, not a
   * zero balance. Rendering that as "0.00" showed a wrong number as though it
   * were right, which for somebody looking at their earnings is the worst
   * possible failure mode. A dash says "unknown" and a refresh fixes it.
   */
  const known = worker.balance !== null && worker.balance !== undefined;
  const balance = known ? Number(worker.balance).toFixed(2) : "—";

  async function copyAddress() {
    try {
      await navigator.clipboard.writeText(worker.address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
      toast({ title: "Address copied", description: worker.address });
    } catch {
      // Clipboard is blocked in some contexts; the full address is on screen
      // in the menu, so there is still a way to get it.
      toast({
        variant: "destructive",
        title: "Could not copy",
        description: "Select the address above and copy it manually.",
      });
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="secondary"
          className="actor-human font-mono flex items-center gap-2 px-2.5 sm:px-3 md:px-4 bg-muted/50 hover:bg-muted/70 border border-border/40 max-w-[170px] sm:max-w-none"
        >
          <span className="actor-dot shrink-0" aria-hidden="true" />
          <span className="hidden lg:inline tabular-nums">{balance} USDC</span>
          <span className="hidden lg:inline text-muted-foreground" aria-hidden="true">
            ·
          </span>
          <span className="truncate">
            {worker.address.slice(0, 6)}…{worker.address.slice(-4)}
          </span>
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="w-72">
        <div className="px-2 py-2">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Wallet className="h-3.5 w-3.5" aria-hidden="true" />
            {worker.handle}
          </div>
          {/* The full address, selectable. Truncation is for the button, not
              for the place someone came to read it. */}
          <div className="text-[11px] text-muted-foreground font-mono break-all mt-1.5 select-all">
            {worker.address}
          </div>
          <div className="text-xs text-muted-foreground mt-2">
            {known ? (
              <>
                Balance:{" "}
                <span className="tabular-nums text-foreground">{balance} USDC</span>
              </>
            ) : (
              "Balance unavailable — try refreshing."
            )}
          </div>
          <div className="text-[11px] text-muted-foreground mt-1.5">
            Held for you. We control the keys to this one.
          </div>
        </div>

        <DropdownMenuSeparator />

        <DropdownMenuItem onClick={() => void copyAddress()}>
          {copied ? (
            <Check className="mr-2 h-4 w-4" aria-hidden="true" />
          ) : (
            <Copy className="mr-2 h-4 w-4" aria-hidden="true" />
          )}
          {copied ? "Copied" : "Copy address"}
        </DropdownMenuItem>

        <DropdownMenuItem
          onClick={(e) => {
            // Keep the menu open so the new balance is visible where it changed.
            e.preventDefault();
            onRefresh();
          }}
          disabled={refreshing}
        >
          <RefreshCw
            className={`mr-2 h-4 w-4 ${refreshing ? "animate-spin" : ""}`}
            aria-hidden="true"
          />
          {refreshing ? "Refreshing…" : "Refresh balance"}
        </DropdownMenuItem>

        <DropdownMenuItem asChild>
          <a
            href={`${EXPLORER}/address/${worker.address}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            <ExternalLink className="mr-2 h-4 w-4" aria-hidden="true" />
            View on explorer
          </a>
        </DropdownMenuItem>

        <DropdownMenuItem asChild>
          <Link to="/get-hired">
            <Wallet className="mr-2 h-4 w-4" aria-hidden="true" />
            My work and earnings
          </Link>
        </DropdownMenuItem>

        <DropdownMenuSeparator />

        <DropdownMenuItem
          className="text-destructive"
          onClick={() => {
            forgetWorker();
            onSignOut();
          }}
        >
          <LogOut className="mr-2 h-4 w-4" aria-hidden="true" />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
