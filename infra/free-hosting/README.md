# No-VPS Hosting Plan

This is the zero-server-rental version.

It cannot do everything the VPS design can do, but it can meet the important parts:

- Admin web GUI at `https://rippermoonstash.com` with no router port forwarding.
- Minecraft Java servers at `servername.rippermoonstash.com` with no remembered ports.
- No VPN for players.
- No VPS.

## What Changes

Use two free tunnel systems:

1. Cloudflare Tunnel for the dashboard web GUI.
2. playit.gg free Minecraft tunnels for game traffic.

```text
Admin browser
  -> https://rippermoonstash.com
  -> Cloudflare Tunnel
  -> this machine:4300

Minecraft Java player
  -> servername.rippermoonstash.com
  -> Porkbun SRV record
  -> playit.gg tunnel host:port
  -> this machine:<local server port>
```

## Hard Limit

There is no fully free, clean way to make arbitrary raw TCP services on your own domain work exactly like a VPS edge.

The workaround for Minecraft Java is DNS `SRV` records. Minecraft Java checks `_minecraft._tcp.<hostname>` and learns the real host and port from DNS. Players still type only `servername.rippermoonstash.com`.

This is Java Edition only. Bedrock does not use this SRV setup.

## Dashboard: Cloudflare Tunnel

Cloudflare Tunnel is free on all plans and uses outbound-only connections, so your router needs no port forwarding.

You will need to use Cloudflare DNS for `rippermoonstash.com`. The domain can stay registered at Porkbun; just change the nameservers at Porkbun to Cloudflare's nameservers.

High-level steps:

1. Create a free Cloudflare account.
2. Add `rippermoonstash.com` to Cloudflare.
3. In Porkbun, change the domain nameservers to the two Cloudflare nameservers.
4. Install `cloudflared` on this machine.
5. Create a tunnel and publish:

```text
rippermoonstash.com -> http://localhost:4300
www.rippermoonstash.com -> http://localhost:4300
```

Use `infra/free-hosting/cloudflared.config.example.yml` as the local config shape.

## Minecraft: playit.gg Free Tunnels

playit.gg has a free tier for Minecraft Java and does not require router port forwarding.

Create one playit Minecraft Java tunnel per local server:

| Server | Local port |
| --- | --- |
| CultOfTheRipper | 31001 |
| AbsoluteChads | 31002 |

After creating each tunnel, playit will give you a public host and port. Put those into:

```bash
cp infra/free-hosting/playit-tunnels.example.json infra/free-hosting/playit-tunnels.json
```

Then run:

```bash
node infra/free-hosting/scripts/generate-porkbun-srv-plan.js
```

Open:

```text
infra/free-hosting/generated/PORKBUN_SRV_RECORDS.md
```

and create those SRV records in Porkbun DNS.

## Porkbun SRV Record Shape

For `cultoftheripper.rippermoonstash.com`, create:

```text
Type: SRV
Host: _minecraft._tcp.cultoftheripper
Answer/Value: 1 1 PLAYIT_PORT PLAYIT_HOST
```

For `absolutechads.rippermoonstash.com`, create:

```text
Type: SRV
Host: _minecraft._tcp.absolutechads
Answer/Value: 1 1 PLAYIT_PORT PLAYIT_HOST
```

The SRV value format is:

```text
PRIORITY WEIGHT PORT TARGET
```

## Sources

- Cloudflare Tunnel is available on all plans and uses outbound-only tunnels: https://developers.cloudflare.com/tunnel/
- Cloudflare Tunnel public hostname routing: https://developers.cloudflare.com/tunnel/routing/
- playit.gg free Minecraft Java tunnels: https://playit.gg/
- playit external domains require premium, so this plan uses Porkbun SRV records instead: https://playit.gg/support/add-external-domain/
- Porkbun Minecraft SRV record guide: https://kb.porkbun.com/article/148-how-to-connect-your-domain-to-minecraft-using-srv-records
