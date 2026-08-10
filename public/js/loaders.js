import { state } from "./state.js";

// The backend is the authority on what it can provision; fall back to the
// conservative original set if bootstrap has not landed yet.
export function installableLoaders() {
  const fromServer = state.bootstrap?.installableLoaders;
  return Array.isArray(fromServer) && fromServer.length ? fromServer : ["vanilla", "paper", "purpur"];
}

export function isInstallableLoader(loader) {
  return installableLoaders().includes(String(loader || "").toLowerCase());
}

export function createLoaderNote(mode, loader) {
  if (mode === "existing") {
    return `existing mode will register the folder as a ${loader} server. nothing is downloaded or installed.`;
  }
  if (isInstallableLoader(loader)) {
    return `managed mode will provision a ${loader} server for the selected minecraft version.`;
  }
  return `${loader} cannot be provisioned automatically. install it yourself and switch to existing mode, otherwise you get a vanilla server labelled ${loader} that loads no mods.`;
}
