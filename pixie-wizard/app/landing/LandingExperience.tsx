import { getSession, isLocalDemoEnabled } from "@/lib/session";
import { PixieNav } from "./PixieNav";
import "./landing.css";

export async function LandingExperience() {
  const session = await getSession();
  const setupHref = session ? "/wizard" : "/api/auth/login";
  const demoHref = !session && isLocalDemoEnabled() ? "/api/auth/dev-login" : null;

  return (
    <div className="pixie-landing">
      <a className="px-skip" href="#main">
        Skip to content
      </a>
      <img
        className="px-art"
        src="/pixie-night-background.png"
        alt=""
        aria-hidden="true"
      />
      <PixieNav setupHref={setupHref} demoHref={demoHref} />
      <main id="main" className="px-main">
        <section className="px-hero" aria-labelledby="landing-title">
          <div className="px-hero-copy">
            <h1 id="landing-title">
              <span>stop answering</span>{" "}
              <span>the same question</span>{" "}
              <span className="px-accent">40 times.</span>
            </h1>
            <p className="px-subcopy">Pixie helps run support for your Slack community.</p>
            <a className="px-primary-cta" href={setupHref}>
              <span className="px-cta-face">
                <span>Set up Pixie</span>
                <span className="px-cta-arrow" aria-hidden="true" />
              </span>
            </a>
          </div>
        </section>
      </main>
    </div>
  );
}
