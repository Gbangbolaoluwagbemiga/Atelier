/**
 * GET HIRED — the door for someone with no wallet.
 *
 * Atelier has two entrances and they are not the same product surface. The main
 * app assumes a connected wallet: you sign your own transactions, you hold your
 * own keys, and everything is on-chain from your address. This page assumes
 * none of that.
 *
 * It exists because the supply side was the harder problem. An agent can start
 * commissioning work with one HTTP call; a designer who has never used crypto
 * had eight steps and three foreign concepts to get through before earning a
 * first dollar. Most of them, reasonably, did not.
 *
 * Deliberately reachable WITHOUT connecting a wallet — that is the entire
 * point, so the route must never be put behind the wallet gate that protects
 * the client area.
 */

import { useCallback, useEffect, useState } from "react";
import { motion } from "framer-motion";
import { Loader2, LogOut, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { WorkerJoin } from "@/components/atelier/worker-join";
import { WorkerBoard } from "@/components/atelier/worker-board";
import {
  WORKER_DOOR_OPEN,
  currentWorkerId,
  forgetWorker,
  me as fetchMe,
  type Worker,
} from "@/lib/atelier/worker";

const TELEGRAM_BOT = (
  (import.meta.env.VITE_TELEGRAM_BOT as string | undefined) ?? ""
).trim();

export default function WorkerPage() {
  const [worker, setWorker] = useState<Worker | null>(null);
  const [checking, setChecking] = useState(true);

  /* Resume a session if this browser has one. A worker id is not a credential
     in any meaningful sense — it is a convenience so returning does not mean
     signing up twice — which is why losing it costs the UI and not the money. */
  const resume = useCallback(async () => {
    const id = currentWorkerId();
    if (!id) {
      setChecking(false);
      return;
    }
    try {
      setWorker(await fetchMe(id));
    } catch {
      // The daemon no longer knows this id — a wiped dev database, usually.
      // Clear it rather than leaving someone stuck on a spinner forever.
      forgetWorker();
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    void resume();
  }, [resume]);

  if (!WORKER_DOOR_OPEN) {
    return (
      <div className="container mx-auto px-4 py-24 max-w-lg text-center">
        <h1 className="font-display text-2xl font-bold">
          The worker service is not running
        </h1>
        <p className="text-muted-foreground mt-3">
          Set <code className="font-mono text-xs">VITE_PATRON_API_URL</code> to a
          running Atelier agent to open this door.
        </p>
      </div>
    );
  }

  if (checking) {
    return (
      <div className="container mx-auto px-4 py-24 flex justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="container mx-auto px-4 py-10 sm:py-14 max-w-3xl">
      {worker ? (
        <>
          <div className="flex flex-wrap items-start justify-between gap-4 mb-8">
            <div>
              <span className="actor-chip actor-human">
                <span className="actor-dot" />
                {worker.mode === "managed" ? "Managed wallet" : "Your wallet"}
              </span>
              <h1 className="font-display text-3xl sm:text-4xl font-bold mt-3">
                {worker.handle}
              </h1>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                forgetWorker();
                setWorker(null);
              }}
            >
              <LogOut className="h-4 w-4 mr-2" aria-hidden="true" />
              Sign out
            </Button>
          </div>

          <WorkerBoard worker={worker} onWorkerChanged={setWorker} />

          <TelegramCard handle={worker.handle} />
        </>
      ) : (
        <>
          <WorkerJoin onJoined={setWorker} />
          <TelegramCard />
        </>
      )}
    </div>
  );
}

/**
 * The second door, for people who would rather not keep a tab open.
 *
 * The Telegram bot is the same worker service underneath — join, browse, apply,
 * submit, withdraw — so someone can start here and continue there, or never
 * open this page at all. Shown even before signing up, because for a lot of
 * people it is the more natural way in.
 */
function TelegramCard({ handle }: { handle?: string }) {
  if (!TELEGRAM_BOT) return null;

  const url = `https://t.me/${TELEGRAM_BOT.replace(/^@/, "")}`;
  return (
    <motion.section
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.3, delay: 0.15 }}
      className="rounded-xl glass p-5 mt-10 flex flex-wrap items-center justify-between gap-4"
    >
      <div className="min-w-0">
        <h2 className="font-medium flex items-center gap-2">
          <Send className="h-4 w-4" aria-hidden="true" />
          Work from Telegram instead
        </h2>
        <p className="text-sm text-muted-foreground mt-1.5 max-w-prose">
          {handle
            ? "Same account, same wallet, same jobs — pushed to you instead of you checking. Send /link in the bot to connect this account."
            : "Browse and apply from a chat, with jobs pushed to you as they appear. No install beyond Telegram itself."}
        </p>
      </div>
      <Button asChild variant="outline" className="shrink-0">
        <a href={url} target="_blank" rel="noopener noreferrer">
          Open the bot
        </a>
      </Button>
    </motion.section>
  );
}
