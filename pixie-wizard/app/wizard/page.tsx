import { redirect } from "next/navigation";
import Link from "next/link";
import { getSession } from "@/lib/session";
import { getOrCreateDraftTrial, stepForTrial } from "@/lib/trials";
import { listHostedProgramsForOwner } from "@/lib/hostedPrograms";
import { decryptSecret } from "@/lib/crypto";
import { listPublicChannels } from "@/lib/slackApi";
import { coreSlackChannels, coreConfigured } from "@/lib/pixieCore";
import { ProgramInfoStep } from "./_components/ProgramInfoStep";
import { LlmKeyStep } from "./_components/LlmKeyStep";
import { SourcesStep } from "./_components/SourcesStep";
import { SlackHandshakeStep } from "./_components/SlackHandshakeStep";
import { ChannelPickerStep } from "./_components/ChannelPickerStep";
import { ReviewStep } from "./_components/ReviewStep";
import { DeployingStep } from "./_components/DeployingStep";
import { SettingsView } from "./_components/SettingsView";
import { HostedSetupView } from "./_components/HostedSetupView";

const HCAI_BASE_URL = "https://ai.hackclub.com/proxy/v1";
const DEFAULT_HCAI_MODEL = "openrouter/free";

export default async function WizardPage({
  searchParams,
}: {
  searchParams: Promise<{ mode?: string }>;
}) {
  const session = await getSession();
  if (!session) redirect("/");

  const { mode } = await searchParams;

  // Hosted shared path: configure a tenant on the already-running Pixie Core.
  // No Slack app, no tokens, no Railway. Legacy dedicated provisioning stays
  // on the default path below.
  if (mode === "hosted") {
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

  const [trial, hosted] = await Promise.all([
    getOrCreateDraftTrial(session),
    listHostedProgramsForOwner(session.hcaId).catch(() => []),
  ]);

  if (trial.status === "provisioning") {
    return <DeployingStep initialStatus={trial.last_deploy_status ?? "QUEUED"} />;
  }

  if (trial.status === "active" || trial.status === "paused" || trial.status === "failed") {
    return <SettingsView trial={trial} />;
  }

  if (trial.status === "awaiting_slack_credentials") {
    if (!trial.slack_bot_token_encrypted) {
      return (
        <SlackHandshakeStep
          programName={trial.program_name}
          defaultBotName={trial.bot_name || trial.program_name}
          defaultBotSlug={trial.bot_slug ?? undefined}
        />
      );
    }

    if (!trial.channels?.helpChannel) {
      let channels: { id: string; name: string }[] = [];
      let listError: string | null = null;
      try {
        channels = await listPublicChannels(decryptSecret(trial.slack_bot_token_encrypted));
      } catch (err) {
        listError = err instanceof Error ? err.message : "unknown error";
      }
      return <ChannelPickerStep channels={channels} listError={listError} />;
    }

    return (
      <ReviewStep
        programName={trial.program_name}
        botName={trial.bot_name || trial.program_name}
        llmBaseUrl={HCAI_BASE_URL}
        llmModel={trial.llm_model || DEFAULT_HCAI_MODEL}
        channels={trial.channels}
        sources={trial.sources}
      />
    );
  }

  if (trial.status !== "draft") {
    return (
      <main className="mx-auto max-w-xl px-6 py-16">
        <p className="font-heading text-xs uppercase tracking-[0.2em] text-brand">
          {trial.program_name}
        </p>
        <h1 className="font-heading mt-3 text-2xl text-text">
          Your trial is at the &quot;{trial.status.replace(/_/g, " ")}&quot; stage.
        </h1>
      </main>
    );
  }

  const step = stepForTrial(trial);

  // Fresh draft + existing hosted programs: surface both paths without
  // disturbing the legacy trial flow. Hosted is the default recommendation.
  if (step === 1) {
    return (
      <>
        <main className="mx-auto max-w-xl px-6 pt-16">
          <div className="rounded-lg border border-mint/40 bg-mint/5 p-5">
            <p className="font-heading text-xs uppercase tracking-[0.2em] text-mint">recommended · live in seconds</p>
            <h2 className="font-heading mt-2 text-lg text-text">Hosted Pixie — shared @Pixie, no setup</h2>
            <p className="mt-1 text-sm text-text-muted">No Slack app, no tokens, no Railway, no AI keys. Just channels and docs.</p>
            {hosted.length > 0 && (
              <ul className="mt-3 space-y-1 text-sm">
                {hosted.map((p) => (
                  <li key={p.id}>
                    <Link href={`/programs/${p.id}`} className="text-text underline">→ {p.program_name}</Link>
                    <span className="text-text-muted"> · {p.status} · sync {p.core_sync_state}</span>
                  </li>
                ))}
              </ul>
            )}
            <Link href="/wizard?mode=hosted" className="mt-4 inline-block rounded-md bg-mint px-4 py-2 font-heading text-sm text-ink">
              Connect with hosted Pixie →
            </Link>
          </div>
          <details className="mt-4 text-sm text-text-muted">
            <summary className="cursor-pointer underline">Need your own container instead? Legacy dedicated path</summary>
            <p className="mt-2">The steps below provision an isolated Railway deployment with its own Slack app. Keep this only if you must self-host.</p>
          </details>
        </main>
        <div className="-mt-8">
          <ProgramInfoStep />
        </div>
      </>
    );
  }
  if (step === 2) return <LlmKeyStep />;
  if (step === 3) return <SourcesStep />;

  return (
    <main className="mx-auto max-w-xl px-6 py-16">
      <p className="font-heading text-xs uppercase tracking-[0.2em] text-mint">
        steps 1-3 done
      </p>
      <h1 className="font-heading mt-3 text-2xl text-text">
        Next up: connect a Slack app.
      </h1>
      <p className="mt-3 text-sm text-text-muted">Refresh in a moment.</p>
      <a href="/api/auth/logout" className="mt-8 inline-block text-sm text-text-muted underline">
        Sign out
      </a>
    </main>
  );
}
