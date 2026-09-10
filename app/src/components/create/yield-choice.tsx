import { Sprout, Wallet } from "lucide-react";

/**
 * WHAT YOUR ESCROW DOES WHILE IT WAITS — asked once, while posting.
 *
 * THIS IS NOT A CHOICE ABOUT WHO PAYS THE FEE
 *
 * It was framed that way and the framing was false. `createEscrow` takes
 * budget + fee unconditionally — the escrow contract has no idea the yield
 * controller exists — so both answers cost exactly the same at the moment you
 * sign, and a client who picked "let the escrow earn it" still watched their
 * wallet ask for the fee. The summary line went further and said the fee was
 * "covered by what the escrow earns", which is not true of any money that has
 * changed hands yet.
 *
 * What actually differs is what happens to the idle portion afterwards, and
 * where the earnings go: the client's fee is the first claim on them. So the
 * fee is a *refund* that may or may not arrive in full, not a bill avoided —
 * and on a short job it will not arrive in full, because 2.5% of a budget is
 * more than a fortnight of any believable rate earns.
 *
 * WHY THIS IS NOT A SWITCH ON THE JOB PAGE
 *
 * It was, and that was wrong. The yield share is a TERM of the job, not a
 * setting on it: a freelancer reads "this escrow earns while you work and 60%
 * of what it earns is yours" on the board and applies partly because of that.
 * A client who could flip it off after hiring would be changing the deal after
 * the other side had accepted it — and the freelancer would have no recourse
 * and, realistically, no idea it had happened.
 *
 * So it is answered here, before the job exists, and the contract refuses to
 * let it change once anybody is hired. Nobody has to trust anybody about it:
 * the tag on a job card means the same thing on delivery day as it did on the
 * day it was posted.
 *
 * WHY IT IS FRAMED AS "WHO PAYS THE FEE"
 *
 * Because that is the actual decision, and it is the one the client cares
 * about. "Enable yield optimisation" is a feature name; "your fee comes back
 * out of what the escrow earns" is a reason. The freelancer's share is stated
 * in the same breath rather than buried, because a client should know they are
 * agreeing to it before they agree to it.
 */

interface Props {
  value: boolean;
  onChange: (next: boolean) => void;
  /** The platform fee in USDC, so the choice is about a real number. */
  fee: number;
  disabled?: boolean;
}

export function YieldChoice({ value, onChange, fee, disabled }: Props) {
  return (
    <div className="space-y-3" data-testid="yield-choice">
      <div>
        <h4 className="font-medium">What your escrow does while it waits</h4>
        <p className="text-sm text-muted-foreground mt-0.5">
          You pay the same either way — ${(fee).toFixed(2)} in platform fee, taken
          when you post. Choose once; it cannot be changed after someone is hired.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Option
          selected={!value}
          disabled={disabled}
          onSelect={() => onChange(false)}
          icon={Wallet}
          title="Just hold it"
          testId="yield-choice-fee"
          body="Your budget sits in escrow until each milestone is approved. Nothing else happens to it."
        />
        <Option
          selected={value}
          disabled={disabled}
          onSelect={() => onChange(true)}
          icon={Sprout}
          title="Put it to work"
          testId="yield-choice-yield"
          body={`The part no milestone can claim yet earns while the job runs. Earnings come back to you first, up to the $${fee.toFixed(2)} you paid; 60% of anything beyond that goes to the freelancer.`}
        />
      </div>

      {value && (
        <p className="text-xs text-muted-foreground" data-testid="yield-choice-note">
          Your next milestone payment always stays in cash, so this never delays
          paying anyone, and the job carries a 🌱 tag on the board. The fee comes
          back as earnings arrive rather than up front — on a short job that is
          usually part of it, not all.
        </p>
      )}
    </div>
  );
}

function Option({
  selected,
  disabled,
  onSelect,
  icon: Icon,
  title,
  body,
  testId,
}: {
  selected: boolean;
  disabled?: boolean;
  onSelect: () => void;
  icon: typeof Sprout;
  title: string;
  body: string;
  testId: string;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={disabled}
      onClick={onSelect}
      data-testid={testId}
      className={`text-left rounded-lg border p-3 transition-colors disabled:opacity-50 ${
        selected
          ? "border-primary bg-primary/5"
          : "border-muted hover:border-primary/40"
      }`}
    >
      <span className="flex items-center gap-2 font-medium">
        <Icon className="h-4 w-4" aria-hidden="true" />
        {title}
      </span>
      <span className="block text-sm text-muted-foreground mt-1">{body}</span>
    </button>
  );
}
