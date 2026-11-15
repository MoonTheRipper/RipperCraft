import { renderBrandMark } from "../components.js";
import { escapeHtml, labelWithIcon } from "../html.js";
import { state } from "../state.js";

export function renderAuth(title, mode) {
  const isSetup = mode === "setup";
  // The server enforces this; the form mirrors it so the browser can say so
  // before anything is sent.
  const minLength = Number(state.bootstrap?.passwordMinLength) || 12;
  // These screens are drawn instead of the shell, which is where the notice
  // banner otherwise lives. Without one here a wrong password, a wrong setup
  // code or "too many attempts" changed nothing a sighted person could see.
  const notice = state.notice
    ? `<div class="notice notice--${escapeHtml(state.notice.type)}" aria-hidden="true">${escapeHtml(state.notice.message)}</div>`
    : "";
  return `
    <main class="auth-shell">
      <figure class="auth-quote">
        <blockquote>with great power comes great responsibility</blockquote>
        <figcaption>Uncle Ben</figcaption>
      </figure>
      <section class="auth-panel">
        <p class="brand-line brand-inline brand-line--stacked">${renderBrandMark("brand-mark--auth")}<span>RipperCraft</span></p>
        <h1>${escapeHtml(title)}</h1>
        <form data-form="${isSetup ? "setup" : "login"}" class="form-grid">
          ${notice}
          ${isSetup
            ? `
              <label>
                <span>Setup Code</span>
                <input
                  name="setupCode"
                  autocomplete="off"
                  autocapitalize="characters"
                  autocorrect="off"
                  spellcheck="false"
                  placeholder="XXXX-XXXX-XXXX-XXXX"
                  required
                />
                <span>Printed in the terminal, or the service journal, each time RipperCraft starts without an owner account.</span>
              </label>
            `
            : ""}
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
            <input type="password" name="password" autocomplete="${isSetup ? "new-password" : "current-password"}" ${isSetup ? `minlength="${minLength}" ` : ""}required />
            ${isSetup ? `<span>At least ${minLength} characters.</span>` : ""}
          </label>
          <button class="button button--primary" type="submit">${labelWithIcon("unlock", isSetup ? "Create Owner Account" : "Log In")}</button>
        </form>
      </section>
    </main>
  `;
}
