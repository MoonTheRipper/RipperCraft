import { handleAppChange } from "./js/actions/change.js";
import { handleAppClick } from "./js/actions/click.js";
import { handleAppSubmit } from "./js/actions/forms.js";
import { removeFailedAddonIcon } from "./js/actions/media.js";
import { refreshAll } from "./js/data.js";
import { getApp } from "./js/dom.js";
import { applyLogScroll, syncLogPolling } from "./js/logs-live.js";
import { applyModalBehaviour, handleAppKeydown } from "./js/modal.js";
import { setNotice } from "./js/notice.js";
import { applyProgressBars } from "./js/progress.js";
import { registerPostRender } from "./js/render.js";

// render() used to call these two directly at the end of a full render. They
// are registered here instead so render.js never has to import logs-live.js,
// which calls render() back. Order matters: the dialog takes focus first (it
// only acts when focus is not already inside it), then scroll is re-pinned,
// then polling is started or stopped.
registerPostRender(applyModalBehaviour);
registerPostRender(applyLogScroll);
registerPostRender(syncLogPolling);
registerPostRender(applyProgressBars);

const app = getApp();

app.addEventListener("click", handleAppClick);
app.addEventListener("submit", handleAppSubmit);
app.addEventListener("change", handleAppChange);
// An image that fails to load does not bubble its error, so this one listens on
// the way down instead.
app.addEventListener("error", removeFailedAddonIcon, true);

// Escape and the dialog focus trap have to be heard even when focus is on the
// document itself, which is why this one is bound to the document.
document.addEventListener("keydown", handleAppKeydown);

refreshAll().catch((error) => {
  setNotice("error", error.message);
});
