import { escapeHtml, labelWithIcon } from "../html.js";
import { OWNER_SECTIONS, SERVER_SECTIONS, state } from "../state.js";

export function renderServerTree() {
  return `
    <section class="tree-block">
      <button class="tree-root ${state.view === "server" ? "tree-root--active" : ""}" data-action="show-servers">${labelWithIcon("server", "servers")}</button>
      <div class="tree-branch tree-branch--root">
        ${state.servers.length
          ? state.servers
              .map((server) => {
                const selected = server.id === state.selectedServerId;
                const expanded = selected && state.view === "server";
                return `
                  <div class="tree-group">
                    <button
                      class="tree-node ${expanded ? "tree-node--active" : ""}"
                      data-action="select-server"
                      data-server-id="${escapeHtml(server.id)}"
                    >
                      ${labelWithIcon("server", server.name)}
                      <span class="tree-meta">${server.status.running ? "up" : "down"}</span>
                    </button>
                    ${expanded
                      ? `
                        <div class="tree-branch">
                          ${SERVER_SECTIONS.map(
                            ([sectionId, label]) => `
                              <button
                                class="tree-leaf ${state.serverSection === sectionId ? "tree-leaf--active" : ""}"
                                data-action="select-server-section"
                                data-section="${sectionId}"
                              >
                                ${labelWithIcon(sectionId, label)}
                              </button>
                            `
                          ).join("")}
                        </div>
                      `
                      : ""}
                  </div>
                `;
              })
              .join("")
          : `<p class="tree-empty">no servers yet</p>`}
      </div>
    </section>
  `;
}

export function renderOwnerTree() {
  if (state.bootstrap.user.role !== "owner") {
    return "";
  }

  return `
    <section class="tree-block">
      <button class="tree-root ${state.view === "owner" ? "tree-root--active" : ""}" data-action="show-owner">${labelWithIcon("owner", "owner")}</button>
      <div class="tree-branch tree-branch--root">
        ${OWNER_SECTIONS.map(
          ([sectionId, label]) => `
            <button
              class="tree-leaf ${state.view === "owner" && state.ownerSection === sectionId ? "tree-leaf--active" : ""}"
              data-action="select-owner-section"
              data-owner-section="${sectionId}"
            >
              ${labelWithIcon(sectionId === "admins" ? "admin" : "server", label)}
            </button>
          `
        ).join("")}
      </div>
    </section>
  `;
}

export function renderSidebar() {
  return `
    <aside class="rail ${state.navOpen ? "rail--open" : ""}" id="primary-nav">
      <div class="rail-top">
        <p class="brand-line">${labelWithIcon("server", "RipperMoonStash", "brand-inline")}</p>
        <p class="session-line">${escapeHtml(state.bootstrap.user.username)} <span>${escapeHtml(state.bootstrap.user.role)}</span></p>
      </div>
      <nav class="tree-nav">
        ${renderServerTree()}
        ${renderOwnerTree()}
      </nav>
      <div class="rail-bottom">
        <button class="button button--quiet" data-action="logout">${labelWithIcon("stop", "log out")}</button>
      </div>
    </aside>
  `;
}
