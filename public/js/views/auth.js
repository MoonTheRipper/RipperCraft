import { escapeHtml, labelWithIcon } from "../html.js";

export function renderAuth(title, mode) {
  const isSetup = mode === "setup";
  return `
    <main class="auth-shell">
      <section class="auth-panel">
        <p class="brand-line brand-inline">RipperMoonStash</p>
        <h1>${escapeHtml(title)}</h1>
        <p class="muted copy">
          ${isSetup
            ? "This dashboard has no accounts yet. The first account you create owns every server on it."
            : "This is the control panel for the Minecraft servers running on this machine. Sign in to start, stop, and manage them."}
        </p>
        <form data-form="${isSetup ? "setup" : "login"}" class="form-grid">
          <label>
            <span>Username</span>
            <input name="username" autocomplete="username" required />
          </label>
          ${isSetup
            ? `
              <label>
                <span>Display Name</span>
                <input name="displayName" placeholder="Ripper Moon" />
              </label>
            `
            : ""}
          <label>
            <span>Password</span>
            <input type="password" name="password" autocomplete="${isSetup ? "new-password" : "current-password"}" required />
          </label>
          <button class="button button--primary" type="submit">${labelWithIcon("unlock", isSetup ? "Create Owner Account" : "Log In")}</button>
        </form>
      </section>
    </main>
  `;
}
