// Project artwork comes from the provider's CDN and sometimes is not there. The
// add-on icon is drawn with a placeholder glyph behind the image, so all a
// failed image has to do is go away.
//
// This is the page's one handler for that, registered on #app for the capture
// phase (image errors do not bubble). Each <img> used to carry its own
// onerror="this.remove()", which is inline script: the Content-Security-Policy
// would have had to allow every inline handler on the page to keep it.
export function removeFailedAddonIcon(event) {
  const image = event.target;
  if (!image || image.tagName !== "IMG" || typeof image.closest !== "function") {
    return;
  }
  if (image.closest(".addon-icon")) {
    image.remove();
  }
}
