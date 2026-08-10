import { render } from "./render.js";
import { state } from "./state.js";

export function setNotice(type, message) {
  state.notice = { type, message };
  render();
}

export function clearNotice() {
  state.notice = null;
}
