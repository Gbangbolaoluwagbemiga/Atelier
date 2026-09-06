/**
 * ATELIER — the top bar.
 *
 * Rewritten from the original navbar, which carried the same seven links twice
 * — once for desktop, once for the mobile sheet — with the active-state class
 * string copy-pasted into each of the fourteen. Adding "My Work" and "Post a
 * Job" to that would have meant four more copies and two more chances for the
 * menus to disagree about what the app contains.
 *
 * The IA now lives in `lib/atelier/nav.ts` and both menus render from it, so
 * there is exactly one list of what this product is.
 */

import { Link, useLocation } from "react-router-dom";
import { WalletButton } from "@/components/wallet-button";
import { NotificationCenter } from "@/components/notification-center";
import { Menu, X } from "lucide-react";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import { useState, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useFreelancerStatus } from "@/hooks/use-freelancer-status";
import { useAdminStatus } from "@/hooks/use-admin-status";
import { useJobCreatorStatus } from "@/hooks/use-job-creator-status";
import { usePendingApprovals } from "@/hooks/use-pending-approvals";
import { useWeb3 } from "@/contexts/web3-context";
import { visibleNav, isCurrent, type NavItem } from "@/lib/atelier/nav";

/** One link, styled identically wherever it appears. */
function NavLink({
  item,
  current,
  badge,
  onNavigate,
  className = "",
}: {
  item: NavItem;
  current: boolean;
  badge?: boolean;
  onNavigate?: () => void;
  className?: string;
}) {
  return (
    <Link
      to={item.to}
      onClick={onNavigate}
      aria-current={current ? "page" : undefined}
      /* whitespace-nowrap because adding a sixth entry made "Browse Jobs" and
         "Post a Job" wrap onto two lines on a narrow laptop, which pushed the
         whole bar taller and read as broken. */
      className={`relative whitespace-nowrap text-sm font-medium transition-colors rounded-md ${
        current
          ? "text-primary bg-primary/10 px-3 py-2"
          : "hover:text-primary px-3 py-2"
      } ${className}`}
    >
      {item.label}
      {badge && (
        <span
          aria-label="needs your attention"
          className="absolute top-1 right-0 h-2 w-2 rounded-full bg-accent"
        />
      )}
    </Link>
  );
}

export function Navbar() {
  const location = useLocation();
  const pathname = location.pathname;
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const mobileMenuRef = useRef<HTMLDivElement>(null);

  const { isFreelancer } = useFreelancerStatus();
  const { isAdmin, isArbiter } = useAdminStatus();
  const { isJobCreator } = useJobCreatorStatus();
  const { hasPendingApprovals } = usePendingApprovals();
  useWeb3();

  const items = visibleNav({
    isFreelancer,
    isClient: isJobCreator,
    isArbiter,
    isAdmin,
  });

  /**
   * Approvals used to be its own nav entry that appeared only when something
   * was waiting. It is a state of My Jobs, not a place, so it is a dot on My
   * Jobs now — one fewer thing in the bar, and it points where the work is.
   */
  const badgeFor = (item: NavItem) =>
    item.to === "/my-jobs" && isJobCreator && hasPendingApprovals;

  useEffect(() => {
    document.body.style.overflow = mobileMenuOpen ? "hidden" : "unset";
    return () => {
      document.body.style.overflow = "unset";
    };
  }, [mobileMenuOpen]);

  useEffect(() => {
    const handleEscapeKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMobileMenuOpen(false);
    };
    document.addEventListener("keydown", handleEscapeKey);
    return () => document.removeEventListener("keydown", handleEscapeKey);
  }, [mobileMenuOpen]);

  /* Route changes should close the sheet. Without this, tapping a link on
     mobile navigates behind a menu that stays open over the new page. */
  useEffect(() => {
    setMobileMenuOpen(false);
  }, [pathname]);

  return (
    <>
      <nav className="fixed top-0 left-0 right-0 z-50 border-b border-border/40 glass">
        <div className="container mx-auto px-4 h-16 flex items-center justify-between gap-2">
          {/* One name. The protocol used to be surfaced here as a subtitle,
              which asked a first-time visitor to hold two brands in their head
              before they had understood one. */}
          <Link to="/" className="flex items-center gap-2.5 shrink-0">
            <img
              src="/atelier-mark.svg"
              alt=""
              aria-hidden="true"
              className="h-7 w-7 shrink-0"
            />
            <span className="flex flex-col leading-none">
              <span className="font-display font-bold text-xl bg-gradient-to-r from-primary to-accent bg-clip-text text-transparent">
                Atelier
              </span>
              <span className="hidden sm:block text-[10px] uppercase tracking-wider text-muted-foreground">
                agents hire people
              </span>
            </span>
          </Link>

          <div className="hidden md:flex items-center gap-0.5 lg:gap-1 min-w-0 overflow-x-auto">
            {items.map((item) => (
              <NavLink
                key={item.to}
                item={item}
                current={isCurrent(pathname, item.to)}
                badge={badgeFor(item)}
              />
            ))}
          </div>

          <div className="flex items-center gap-2 min-w-0">
            <div className="hidden md:block">
              <ThemeToggle />
            </div>
            <div className="shrink-0">
              <NotificationCenter />
            </div>
            <div className="shrink-0">
              <WalletButton />
            </div>

            <Button
              aria-label="Toggle menu"
              aria-expanded={mobileMenuOpen}
              variant="ghost"
              size="icon"
              className="md:hidden ml-1 relative z-50"
              onClick={() => setMobileMenuOpen((open) => !open)}
            >
              {mobileMenuOpen ? (
                <X className="h-5 w-5" />
              ) : (
                <Menu className="h-5 w-5" />
              )}
            </Button>
          </div>
        </div>

        <AnimatePresence>
          {mobileMenuOpen && (
            <motion.div
              ref={mobileMenuRef}
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.2 }}
              className="md:hidden border-t border-border/40 bg-background overflow-hidden"
            >
              <div className="container mx-auto px-4 py-4 flex flex-col gap-1">
                {items.map((item) => (
                  <NavLink
                    key={item.to}
                    item={item}
                    current={isCurrent(pathname, item.to)}
                    badge={badgeFor(item)}
                    onNavigate={() => setMobileMenuOpen(false)}
                    className="py-3"
                  />
                ))}
                <div className="pt-3 mt-2 border-t border-border/40">
                  <ThemeToggle />
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </nav>

      <AnimatePresence>
        {mobileMenuOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="fixed inset-0 bg-black/50 backdrop-blur-sm z-40 md:hidden"
            onClick={() => setMobileMenuOpen(false)}
          />
        )}
      </AnimatePresence>
    </>
  );
}
