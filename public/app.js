import { handleAppChange } from "./js/actions/change.js";
import { handleAppClick } from "./js/actions/click.js";
import { handleAppSubmit } from "./js/actions/forms.js";
import { refreshAll } from "./js/data.js";
import { getApp } from "./js/dom.js";
import { applyLogScroll, syncLogPolling } from "./js/logs-live.js";
import { setNotice } from "./js/notice.js";
import { registerPostRender } from "./js/render.js";

// render() used to call these two directly at the end of a full render. They
// are registered here instead so render.js never has to import logs-live.js,
// which calls render() back. Order matters: scroll is re-pinned first, then
// polling is started or stopped, exactly as before.
registerPostRender(applyLogScroll);
registerPostRender(syncLogPolling);

const app = getApp();

app.addEventListener("click", handleAppClick);
app.addEventListener("submit", handleAppSubmit);
app.addEventListener("change", handleAppChange);

refreshAll().catch((error) => {
  setNotice("error", error.message);
});
