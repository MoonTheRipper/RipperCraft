# Minecraft Java SRV records for rippermoonstash.com

Create one SRV record per server, at whichever provider is authoritative
for rippermoonstash.com. Check with:

```bash
dig +short NS rippermoonstash.com
```

`*.ns.cloudflare.com` means the records live in Cloudflare DNS, not at the
registrar - moving nameservers to Cloudflare leaves the registrar's own DNS
panel inert.

## Single-field providers (Porkbun and most registrars)

| Server | Players type | Type | Host | Answer/Value |
| --- | --- | --- | --- | --- |
| CultOfTheRipper | cultoftheripper.rippermoonstash.com | SRV | _minecraft._tcp.cultoftheripper | 1 1 8650 european-copyrighted.gl.at.ply.gg |
| AbsoluteChads | absolutechads.rippermoonstash.com | SRV | _minecraft._tcp.absolutechads | 1 1 8659 german-indirect.gl.at.ply.gg |
| TheLastOfMines | thelastofmines.rippermoonstash.com | SRV | _minecraft._tcp.thelastofmines | 1 1 60282 atoms-lister.tun.ply.gg |

## Cloudflare DNS (separate fields per record)

### CultOfTheRipper — players type `cultoftheripper.rippermoonstash.com`

| Field | Value |
| --- | --- |
| Type | `SRV` |
| Name | `cultoftheripper` |
| Service | `_minecraft` |
| Protocol | `TCP` |
| TTL | Auto |
| Priority | `1` |
| Weight | `1` |
| Port | `8650` |
| Target | `european-copyrighted.gl.at.ply.gg` |

### AbsoluteChads — players type `absolutechads.rippermoonstash.com`

| Field | Value |
| --- | --- |
| Type | `SRV` |
| Name | `absolutechads` |
| Service | `_minecraft` |
| Protocol | `TCP` |
| TTL | Auto |
| Priority | `1` |
| Weight | `1` |
| Port | `8659` |
| Target | `german-indirect.gl.at.ply.gg` |

### TheLastOfMines — players type `thelastofmines.rippermoonstash.com`

| Field | Value |
| --- | --- |
| Type | `SRV` |
| Name | `thelastofmines` |
| Service | `_minecraft` |
| Protocol | `TCP` |
| TTL | Auto |
| Priority | `1` |
| Weight | `1` |
| Port | `60282` |
| Target | `atoms-lister.tun.ply.gg` |

Notes:
- Single-field Answer/Value format is: priority, weight, port, target.
- Players type only the hostname. Do not add a port in Minecraft.
- SRV records are never proxied; there is no orange cloud to turn off.
- No A record is needed for the play hostname. Minecraft Java resolves SRV first.
- Java Edition only. Bedrock ignores these records.
- Verify with: `dig +short SRV _minecraft._tcp.<slug>.<domain>`

