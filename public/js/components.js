import { escapeHtml, labelWithIcon, renderSelectOptions } from "./html.js";
import { state } from "./state.js";

export function renderSafeSettingField(definition, value) {
  if (definition.type === "boolean") {
    return `
      <label>
        <span>${escapeHtml(definition.key)}</span>
        <select name="${escapeHtml(definition.key)}">
          ${renderSelectOptions(["true", "false"], value)}
        </select>
      </label>
    `;
  }

  if (definition.type === "enum") {
    return `
      <label>
        <span>${escapeHtml(definition.key)}</span>
        <select name="${escapeHtml(definition.key)}">
          ${renderSelectOptions(definition.options || [], value)}
        </select>
      </label>
    `;
  }

  return `
    <label>
      <span>${escapeHtml(definition.key)}</span>
      <input name="${escapeHtml(definition.key)}" value="${escapeHtml(value || "")}" ${definition.type === "number" ? 'inputmode="numeric"' : ""} />
    </label>
  `;
}

export function renderVersionDatalist(listId, includeLatest = false) {
  const versions = state.versionCatalog?.versions || [];
  if (!versions.length) {
    return "";
  }

  return `
    <datalist id="${escapeHtml(listId)}">
      ${includeLatest ? '<option value="latest" label="latest release"></option>' : ""}
      ${versions
        .map(
          (version) => `
            <option
              value="${escapeHtml(version.id)}"
              label="${escapeHtml(`${version.type} · ${new Date(version.releaseTime).toLocaleDateString()}`)}"
            ></option>
          `
        )
        .join("")}
    </datalist>
  `;
}

export function renderMinecraftVersionOptions(includeLatest = false) {
  const versions = state.versionCatalog?.versions || [];
  return `
    ${includeLatest ? '<option value="latest">latest release</option>' : ""}
    ${versions
      .map(
        (version) => `
          <option value="${escapeHtml(version.id)}">
            ${escapeHtml(version.id)} ${version.type === "release" ? "release" : "snapshot"}
          </option>
        `
      )
      .join("")}
  `;
}

export function renderCreateVersionPicker() {
  const selected = state.createServerMinecraftVersion || "latest";
  const versions = [
    ...(state.versionCatalog?.latest?.release ? [{ id: "latest", label: `latest release (${state.versionCatalog.latest.release})` }] : [{ id: "latest", label: "latest release" }]),
    ...((state.versionCatalog?.versions || []).map((version) => ({
      id: version.id,
      label: `${version.id} ${version.type === "release" ? "release" : "snapshot"}`
    })))
  ];
  const selectedVersion = versions.find((version) => version.id === selected) || versions[0] || { id: "latest", label: "latest release" };

  return `
    <div class="version-picker ${state.createVersionOpen ? "version-picker--open" : ""}" data-version-picker>
      <input type="hidden" name="minecraftVersion" value="${escapeHtml(selectedVersion.id)}" />
      <button class="version-picker__button" type="button" data-action="toggle-create-version-picker" aria-expanded="${state.createVersionOpen ? "true" : "false"}">
        <span>
          <span class="version-picker__label">minecraft version</span>
          <strong>${escapeHtml(selectedVersion.label)}</strong>
        </span>
        <span class="version-picker__chevron">⌄</span>
      </button>
      ${state.createVersionOpen
        ? `
          <div class="version-picker__menu">
            ${versions
              .map(
                (version) => `
                  <button
                    class="version-picker__option ${version.id === selectedVersion.id ? "version-picker__option--active" : ""}"
                    type="button"
                    data-action="select-create-version"
                    data-version="${escapeHtml(version.id)}"
                  >
                    ${escapeHtml(version.label)}
                  </button>
                `
              )
              .join("")}
          </div>
        `
        : ""}
    </div>
  `;
}

export function renderPageHeader(pathLabel, title, subtitle, actions = "") {
  return `
    <header class="page-header">
      <p class="path-line">${escapeHtml(pathLabel)}</p>
      <div class="page-header__top">
        <div>
          <h1>${escapeHtml(title)}</h1>
          <p class="muted copy">${escapeHtml(subtitle || "")}</p>
        </div>
        ${actions ? `<div class="page-actions">${actions}</div>` : ""}
      </div>
    </header>
  `;
}

export function renderMetaRows(rows) {
  return `
    <div class="meta-list">
      ${rows
        .map(
          ([label, value]) => `
            <div class="meta-row">
              <span>${escapeHtml(label)}</span>
              <strong>${value}</strong>
            </div>
          `
        )
        .join("")}
    </div>
  `;
}

export function renderSection(title, subtitle, body) {
  const sectionIcon =
    title === "lane" ? "unlock" :
    title === "eula" ? "overview" :
    title === "server" ? "server" :
    title === "settings" ? "settings" :
    title === "worlds" ? "worlds" :
    title === "mods" ? "mods" :
    title === "logs" ? "logs" :
    title === "updates" ? "refresh" :
    title.includes("server") ? "server" :
    title.includes("user") ? "admin" :
    title.includes("admin") ? "admin" :
    "overview";

  return `
    <section class="section-block">
      <div class="section-heading">
        <h2>${labelWithIcon(sectionIcon, title)}</h2>
        ${subtitle ? `<p class="muted">${escapeHtml(subtitle)}</p>` : ""}
      </div>
      <div class="section-body">
        ${body}
      </div>
    </section>
  `;
}

export function renderJavaBinSelect(server) {
  const runtimes = Array.isArray(state.javaRuntimes) ? state.javaRuntimes : [];
  const current = server.javaBin || "";
  const known = runtimes.some((runtime) => runtime.path === current);

  return `
    <select name="javaBin">
      <option value=""${current ? "" : " selected"}>use dashboard default</option>
      ${runtimes
        .map(
          (runtime) =>
            `<option value="${escapeHtml(runtime.path)}"${runtime.path === current ? " selected" : ""}>${escapeHtml(runtime.label)}</option>`
        )
        .join("")}
      ${current && !known
        ? `<option value="${escapeHtml(current)}" selected>${escapeHtml(current)} (not detected)</option>`
        : ""}
    </select>
  `;
}

export function renderJavaBinNote(server) {
  const runtimes = Array.isArray(state.javaRuntimes) ? state.javaRuntimes : [];
  const current = server.javaBin || "";
  const known = runtimes.some((runtime) => runtime.path === current);

  if (!runtimes.length) {
    return `<p class="muted">no java installations were detected on this machine. the dashboard default will be used.</p>`;
  }
  if (current && !known) {
    return `<p class="muted">this server points at <code>${escapeHtml(current)}</code>, which was not found on this machine. the server will fail to start until you pick a detected version.</p>`;
  }
  return `<p class="muted">only set this when a server needs a different jdk from the rest, for example forge 1.20.1 wants java 17 while newer versions want java 21+. detected from this machine: ${runtimes.map((runtime) => escapeHtml(String(runtime.major ?? "?"))).join(", ")}.</p>`;
}
