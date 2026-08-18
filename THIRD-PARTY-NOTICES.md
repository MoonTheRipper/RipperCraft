# Third-party notices

RipperCraft bundles the following third-party work. Everything listed here is
inlined into the source tree rather than fetched at runtime, so the dashboard
has no third-party runtime dependencies and works without network access.

## The RipperCraft logo (not third-party)

The scythe mark is the project's own artwork, not licensed from anywhere. The
master lives at `src/RipperCraftLogo.png`; everything served from `public/`
(`logo.png`, `icon-*.png`, `apple-touch-icon.png`, `favicon*`) is derived from
it by `scripts/generate-brand-assets.py`. Re-run that script after replacing the
master and commit what it writes.

The logo is not covered by whatever license this project ships under unless the
owner says so — anyone forking should replace it with their own mark.

## Pixelarticons

Pixel-art icon set used for the dashboard interface (`public/js/icons.js`).

- Version: 2.4.1
- Author: Gerrit Halfmann
- Homepage: https://github.com/halfmage/pixelarticons
- License: MIT

```
MIT License

Copyright (c) 2019 Gerrit Halfmann

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Add-on artwork

Project icons shown next to installed and searchable add-ons are served from
Modrinth (`cdn.modrinth.com`) and CurseForge (`media.forgecdn.net`) using the
icon URL each provider's API returns for that project. The artwork belongs to
the respective mod authors; RipperCraft neither stores nor redistributes it, and
the `<img>` tags carry `referrerpolicy="no-referrer"` so browsing the dashboard
does not leak its address to those hosts.

## Not bundled

RipperCraft is not affiliated with or endorsed by Mojang Studios or Microsoft.
No Minecraft assets, textures, or fonts are included in this repository. The
loader runtimes (Fabric, Forge, NeoForge) and the Minecraft server itself are
downloaded from their official distributors at install time and are covered by
their own licenses.
