import { escapeHtml, labelWithIcon } from "../html.js";

export function renderAuth(title, subtitle, mode) {
  const isSetup = mode === "setup";
  return `
    <main class="auth-shell">
      <figure class="auth-quote">
        <blockquote>with great power comes great responsibility</blockquote>
        <figcaption>Uncle Ben</figcaption>
      </figure>
      <section class="auth-panel">
        <p class="brand-line brand-inline">RipperMoonStash</p>
        <h1>${escapeHtml(title)}</h1>
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
