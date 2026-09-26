export function PixieNav({ setupHref, demoHref }: { setupHref: string; demoHref?: string | null }) {
  return (
    <header className="px-nav">
      <a className="px-logo" href="/" aria-label="Pixie home">
        pixie<span>.</span>
      </a>
      <nav className="px-nav-links" aria-label="Primary">
        <a className="px-signin" href="/api/auth/login">
          Sign in
        </a>
        {demoHref ? (
          <a className="px-signin" href={demoHref} data-demo-login="true">
            Try demo
          </a>
        ) : null}
        <a className="px-primary-cta px-nav-cta" href={setupHref}>
          <span className="px-cta-face">
            <span>Set up Pixie</span>
          </span>
        </a>
      </nav>
    </header>
  );
}
