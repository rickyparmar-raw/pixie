import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import { coreSlackChannels, coreConfigured } from "@/lib/pixieCore";
import { HostedSetupView } from "./_components/HostedSetupView";

// Hosted Pixie is the only path: configure a tenant on the already-running
// Pixie Core. No Slack app, no bot tokens, no LLM keys, no Railway — the
// legacy dedicated/self-host provisioning flow has been removed.
export default async function WizardPage() {
  const session = await getSession();
  if (!session) redirect("/");

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
