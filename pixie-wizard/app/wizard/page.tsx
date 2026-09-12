import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import { creatorEligible } from "@/lib/programClaim";
import { coreSlackChannels, coreConfigured } from "@/lib/pixieCore";
import { HostedSetupView } from "./_components/HostedSetupView";

// Hosted Pixie is the only path: configure a tenant on the already-running
// Pixie Core. No Slack app, no bot tokens, no LLM keys, no Railway — the
// legacy dedicated/self-host provisioning flow has been removed.
export default async function WizardPage() {
  const session = await getSession();
  if (!session) redirect("/");

  // Program creation is invite-only. activateHostedProgram() re-checks this
  // server-side; this is the matching UX so an ineligible account sees why
  // rather than a form that fails on submit.
  if (!creatorEligible(session)) {
    return (
      <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 py-16 text-center">
        <h1 className="font-heading text-xl text-text">Program setup is invite-only</h1>
        <p className="mt-3 text-sm leading-relaxed text-text-muted">
          Your account can sign in and help on programs you&apos;re added to, but a Pixie
          admin needs to enable it before you can create one. Ask whoever runs Pixie for
          your workspace.
        </p>
        <Link href="/" className="pixie-button pixie-button-quiet mx-auto mt-6">
          Back to pixie.support
        </Link>
      </main>
    );
  }

  let channels: { id: string; name: string; isMember: boolean }[] = [];
  let coreLive = false;
  if (coreConfigured()) {
    try {
      const res = await coreSlackChannels();
      if (res.ok) {
        channels = res.channels;
        coreLive = true;
      }
    } catch {
      coreLive = false;
    }
  }

  return <HostedSetupView channels={channels} coreLive={coreLive} />;
}
