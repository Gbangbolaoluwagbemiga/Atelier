/**
 * MY JOBS — one place, whichever side of the table you are on.
 *
 * Atelier previously had "My Work" and "My Jobs" as separate destinations, which
 * made sense to whoever built it and to nobody using it. Most people on a
 * marketplace like this do both: you hire someone for a logo and take a writing
 * job the same week. Two nav entries meant two dashboards, two mental models,
 * and two places to check whether anything needed you.
 *
 * So: one destination, and the tabs appear only if you actually have both roles.
 *
 *   both roles  → tabs, and it opens on whichever side needs you
 *   one role    → that side, no tabs, no reminder that another mode exists
 *   neither     → an explanation and the two ways to start
 *
 * The tab bar is not shown to someone with one role on purpose. A freelancer who
 * has never hired anybody does not need a permanently empty "Hiring" tab
 * teaching them the product has a part they are not using.
 */

import { useEffect, useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import { Link } from "react-router-dom";
import { Briefcase, Hammer, Loader2 } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { useWeb3 } from "@/contexts/web3-context";
import { useFreelancerStatus } from "@/hooks/use-freelancer-status";
import { useJobCreatorStatus } from "@/hooks/use-job-creator-status";
import DashboardPage from "@/pages/DashboardPage";
import FreelancerPage from "@/pages/FreelancerPage";

type Side = "hiring" | "working";

export default function MyJobsPage() {
  const { wallet } = useWeb3();
  const { isFreelancer, loading: freelancerLoading } = useFreelancerStatus();
  const { isJobCreator, loading: clientLoading } = useJobCreatorStatus();
  const [params, setParams] = useSearchParams();

  const loading = freelancerLoading || clientLoading;
  const both = isJobCreator && isFreelancer;

  /**
   * Which side to open on.
   *
   * A URL parameter wins, so /work can redirect here and land on the right tab
   * and a link to one side stays a link to that side. Otherwise default to
   * whichever role you have; with both, default to hiring, because that is the
   * side where something is usually waiting on YOU — a freelancer's jobs are
   * waiting on the freelancer's own work, which they know about already.
   */
  const requested = params.get("tab");
  const side: Side = useMemo(() => {
    if (requested === "working" || requested === "hiring") return requested;
    if (isJobCreator) return "hiring";
    if (isFreelancer) return "working";
    return "hiring";
  }, [requested, isJobCreator, isFreelancer]);

  /* Keep the URL honest once the roles resolve, so a refresh or a shared link
     lands in the same place rather than re-deciding. */
  useEffect(() => {
    if (loading || !both) return;
    if (requested !== "hiring" && requested !== "working") {
      setParams({ tab: side }, { replace: true });
    }
  }, [loading, both, requested, side, setParams]);

  if (!wallet.isConnected) {
    return (
      <EmptyState
        title="Connect a wallet to see your jobs"
        body="Everything you have posted or been hired for lives here, on both sides."
      />
    );
  }

  if (loading) {
    return (
      <div className="container mx-auto px-4 py-24 flex items-center justify-center gap-2.5 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        Loading your jobs…
      </div>
    );
  }

  if (!isJobCreator && !isFreelancer) {
    return (
      <EmptyState
        title="Nothing here yet"
        body="Once you post a job or get hired for one, it shows up here — both sides in the same place."
      />
    );
  }

  /* One role: give them that page, with nothing to switch between. */
  if (!both) {
    return (
      <div className="min-h-screen py-8 sm:py-12">
        <div className="container mx-auto px-4 mb-6 sm:mb-8">
          <h1 className="font-display text-3xl sm:text-4xl font-bold">My Jobs</h1>
          <p className="text-muted-foreground mt-1.5">
            {isJobCreator
              ? "The jobs you have posted and are paying for."
              : "The jobs you have been hired for, and what you have earned."}
          </p>
        </div>
        {isJobCreator ? <DashboardPage embedded /> : <FreelancerPage embedded />}
      </div>
    );
  }

  return (
    <div className="min-h-screen py-8 sm:py-12">
      <div className="container mx-auto px-4">
        <h1 className="font-display text-3xl sm:text-4xl font-bold">My Jobs</h1>
        <p className="text-muted-foreground mt-1.5">
          You are hiring on some of these and working on others.
        </p>

        <Tabs
          value={side}
          onValueChange={(v) => setParams({ tab: v }, { replace: true })}
          className="mt-6"
        >
          {/* Scrolls rather than wrapping on a narrow screen — a tab bar that
              reflows onto two lines pushes the content down and looks broken. */}
          <TabsList className="w-full sm:w-auto overflow-x-auto justify-start">
            <TabsTrigger value="hiring" className="gap-2 shrink-0">
              <Briefcase className="h-4 w-4" aria-hidden="true" />
              Hiring
            </TabsTrigger>
            <TabsTrigger value="working" className="gap-2 shrink-0">
              <Hammer className="h-4 w-4" aria-hidden="true" />
              Working
            </TabsTrigger>
          </TabsList>

          {/* Both stay mounted. Switching tabs should not re-fetch a dashboard
              that was already loaded — on a slow RPC that reads as the app
              losing your jobs every time you look at the other side. */}
          <TabsContent value="hiring" forceMount hidden={side !== "hiring"} className="mt-6">
            <DashboardPage embedded />
          </TabsContent>
          <TabsContent value="working" forceMount hidden={side !== "working"} className="mt-6">
            <FreelancerPage embedded />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="container mx-auto px-4 py-20 sm:py-28 max-w-lg text-center">
      <h1 className="font-display text-2xl sm:text-3xl font-bold">{title}</h1>
      <p className="text-muted-foreground mt-3 leading-relaxed">{body}</p>
      <div className="flex flex-col sm:flex-row gap-3 justify-center mt-8">
        <Button asChild>
          <Link to="/jobs">Browse jobs</Link>
        </Button>
        <Button asChild variant="outline">
          <Link to="/post">Post a job</Link>
        </Button>
      </div>
    </div>
  );
}
