/**
 * Becoming a freelancer, in one field.
 *
 * The whole point of this screen is what it does NOT ask for. No email, no
 * password, no seed phrase, no network to add, no gas to source. A name, and
 * optionally what you do. Everything else is provisioned behind it.
 *
 * The honesty panel is not a disclaimer bolted on at the end — it is load
 * bearing. We are creating a wallet the daemon holds the keys to, and a person
 * agreeing to that should be told before they earn anything rather than when
 * they try to withdraw. Saying it here, in the same breath as "no install
 * needed", is what makes the convenience an offer rather than a trick.
 */

import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { KeyRound, Loader2, Wallet } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { toastError } from "@/lib/atelier/errors";
import { join, recover, type Worker } from "@/lib/atelier/worker";
import {
  GOOGLE_SIGNIN_AVAILABLE,
  renderGoogleButton,
} from "@/lib/atelier/google-signin";

export function WorkerJoin({ onJoined }: { onJoined: (w: Worker) => void }) {
  const { toast } = useToast();
  const [handle, setHandle] = useState("");
  const [skills, setSkills] = useState("");
  const [returning, setReturning] = useState(false);
  /* The verified token, and the address it belongs to purely for display. The
     browser is never the authority on who this is — the daemon reads that out
     of Google's signature. */
  const [idToken, setIdToken] = useState<string | null>(null);
  const [signedInAs, setSignedInAs] = useState<string | null>(null);
  const googleButtonRef = useRef<HTMLDivElement>(null);
  const [ownAddress, setOwnAddress] = useState("");
  const [useOwnWallet, setUseOwnWallet] = useState(false);
  const [busy, setBusy] = useState(false);

  const validOwnAddress =
    !useOwnWallet || /^0x[a-fA-F0-9]{40}$/.test(ownAddress.trim());
  /* A managed wallet needs a verified sign-in. Somebody bringing their own
     address needs none of it — they hold the keys, so there is nothing here to
     steal. */
  const ready =
    handle.trim().length >= 2 && validOwnAddress && (useOwnWallet || !!idToken);

  useEffect(() => {
    if (useOwnWallet || !googleButtonRef.current) return;
    void renderGoogleButton(
      googleButtonRef.current,
      (token) => {
        setIdToken(token);
        // Read only to show who signed in. The daemon does not trust this.
        try {
          const claims = JSON.parse(atob(token.split(".")[1] ?? "")) as {
            email?: string;
          };
          setSignedInAs(claims.email ?? null);
        } catch {
          setSignedInAs(null);
        }
      },
      (message) =>
        toast({ variant: "destructive", title: "Google sign-in", description: message }),
    );
  }, [useOwnWallet, toast]);

  async function submit() {
    setBusy(true);
    try {
      if (returning) {
        const existing = await recover(idToken ?? "");
        toast({
          title: `Welcome back, ${existing.handle}`,
          description: "Same account, same wallet.",
        });
        onJoined(existing);
        return;
      }

      const worker = await join({
        handle: handle.trim(),
        idToken: useOwnWallet ? undefined : (idToken ?? undefined),
        skills: skills.trim() || undefined,
        ownAddress: useOwnWallet ? ownAddress.trim() : undefined,
      });
      toast({
        title: `Welcome, ${worker.handle}`,
        description: useOwnWallet
          ? "Your own wallet is linked. You sign everything yourself."
          : "A wallet has been created for you. You can start applying.",
      });
      onJoined(worker);
    } catch (e) {
      toast(toastError("Could not sign you up", e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35 }}
      className="actor-human max-w-lg"
    >
      <span className="actor-chip">
        <span className="actor-dot" />
        Get hired
      </span>

      <h1 className="font-display text-3xl sm:text-4xl font-bold tracking-tight mt-4">
        Start earning in one step
      </h1>
      <p className="text-muted-foreground mt-3 leading-relaxed">
        No install, no seed phrase, no gas. Pick a name and you are a freelancer
        who can apply to funded work and be paid in USDC.
      </p>

      <div className="space-y-4 mt-8">
        <div>
          <Label htmlFor="handle">What should we call you?</Label>
          <Input
            id="handle"
            value={handle}
            onChange={(e) => setHandle(e.target.value)}
            placeholder="ada"
            className="mt-1.5"
            autoComplete="off"
          />
        </div>

        {!useOwnWallet && (
          <div>
            <Label>Sign in to hold your wallet</Label>
            <p className="text-xs text-muted-foreground mt-1.5 mb-3 leading-relaxed">
              Your Google account is what gets you back to the same wallet later
              — and what stops anyone else reaching it by knowing your email.
            </p>
            {/* Google's own rendered button. Their branding rules require it,
                and a hand-rolled one posting to their endpoint is exactly what a
                phishing page looks like. */}
            <div ref={googleButtonRef} className="min-h-[44px]" />
            {!GOOGLE_SIGNIN_AVAILABLE && (
              <p className="text-xs text-muted-foreground mt-2">
                Google sign-in is not configured for this deployment — set
                <code className="mx-1 font-mono">VITE_GOOGLE_CLIENT_ID</code>.
              </p>
            )}
            {signedInAs && (
              <p className="text-xs actor-text mt-2">Signed in as {signedInAs}</p>
            )}
          </div>
        )}

        <div>
          <Label htmlFor="skills">
            What do you do?{" "}
            <span className="text-muted-foreground font-normal">optional</span>
          </Label>
          <Input
            id="skills"
            value={skills}
            onChange={(e) => setSkills(e.target.value)}
            placeholder="logos, brand identity, illustration"
            className="mt-1.5"
          />
          <p className="text-xs text-muted-foreground mt-1.5">
            Autopilot reads this when it scores applicants.
          </p>
        </div>

        {/* ── The honest bit, before anyone earns anything ── */}
        <div className="rounded-xl border border-border/60 p-4">
          <div className="flex gap-3">
            <Wallet
              className="h-4 w-4 mt-0.5 shrink-0 text-muted-foreground"
              aria-hidden="true"
            />
            <div className="text-sm text-muted-foreground leading-relaxed">
              <strong className="text-foreground font-medium">
                We will hold your wallet for you.
              </strong>{" "}
              That is what removes the setup — but it means we control the keys,
              not you. Withdraw to an address you own once you have been paid,
              and switch to your own wallet whenever you like.
            </div>
          </div>

          <button
            type="button"
            onClick={() => setUseOwnWallet((v) => !v)}
            className="mt-3 inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            <KeyRound className="h-3.5 w-3.5" aria-hidden="true" />
            {useOwnWallet
              ? "Actually, create one for me"
              : "I already have a wallet and want to keep my own keys"}
          </button>

          {useOwnWallet && (
            <div className="mt-3">
              <Label htmlFor="ownAddress" className="text-xs">
                Your address
              </Label>
              <Input
                id="ownAddress"
                value={ownAddress}
                onChange={(e) => setOwnAddress(e.target.value)}
                placeholder="0x…"
                className="mt-1.5 font-mono text-sm"
              />
              {ownAddress.trim().length > 0 && !validOwnAddress && (
                <p className="text-xs text-destructive mt-1.5">
                  That is not a valid address.
                </p>
              )}
              <p className="text-xs text-muted-foreground mt-1.5">
                You will sign your own transactions, and need gas on Arc to do
                it.
              </p>
            </div>
          )}
        </div>

        <Button
          size="lg"
          className="w-full"
          disabled={!ready || busy}
          onClick={() => void submit()}
        >
          {busy && (
            <Loader2 className="h-4 w-4 mr-2 animate-spin" aria-hidden="true" />
          )}
          {useOwnWallet
            ? "Link my wallet"
            : returning
              ? "Get back into my account"
              : "Create my account"}
        </Button>

        {!useOwnWallet && (
          <button
            type="button"
            onClick={() => setReturning((v) => !v)}
            className="w-full text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            {returning
              ? "Actually, I am new here"
              : "I have been here before — get me back into my account"}
          </button>
        )}
      </div>
    </motion.div>
  );
}
