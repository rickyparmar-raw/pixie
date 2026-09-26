import type { CoreChannel } from "@/lib/pixieCore";
import type { OnboardingDraft } from "@/lib/onboardingDraft";

export interface StepProps {
  draft: OnboardingDraft;
  update: (patch: Partial<OnboardingDraft> | ((d: OnboardingDraft) => OnboardingDraft)) => void;
  demoMode: boolean;
  coreLive: boolean;
  channels: CoreChannel[];
  creatorSlackId: string | null;
}

export interface GoLiveStepProps extends StepProps {
  serverError: string | null;
}
