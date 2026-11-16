# RipperCraft Hosting Plan

This design gives you:

- `example.com` for the admin web GUI.
- `servername.example.com` for Minecraft Java servers.
- No router port forwarding to the home server.
- No player VPN requirement.
- Random/local Minecraft backend ports that do not matter to players.

## Architecture

Use a small public VPS as the edge:

```text
Players
  -> servername.example.com:25565
  -> VPS Velocity proxy
  -> VPS 127.0.0.1:26xxx
  -> frp outbound tunnel
  -> home game server 127.0.0.1:<actual Minecraft port>

Admins
  -> https://example.com
  -> VPS Caddy
  -> VPS 127.0.0.1:4300
  -> frp outbound tunnel
  -> home dashboard 127.0.0.1:4300
```

The VPS only needs public inbound ports:

- `80/tcp` and `443/tcp` for Caddy and HTTPS.
- `25565/tcp` for Minecraft Java players.
- `7000/tcp` for `frpc` on the home server to reach `frps` on the VPS.

The home router needs no inbound port forwards.

## Why DNS Alone Is Not Enough

DNS can point `server.example.com` to an IP, but Minecraft Java traffic is raw TCP. DNS cannot decide which local backend port should receive the connection. Velocity handles the Minecraft hostname routing, and frp carries private backend connections from the VPS to your home server.

## Porkbun DNS

Create records for `example.com`:

| Type | Host | Answer |
| --- | --- | --- |
| A | @ | VPS public IPv4 |
| A | * | VPS public IPv4 |

If the VPS has IPv6, also add:

| Type | Host | Answer |
| --- | --- | --- |
| AAAA | @ | VPS public IPv6 |
| AAAA | * | VPS public IPv6 |

Porkbun wildcard DNS uses `*` as the host for all undefined subdomains. The root domain still needs its own `@` record.

## Generate Configs

Create your local config:

```bash
cp infra/hosting/hosting.config.example.json infra/hosting/hosting.config.json
```

Edit:

- `frpServerAddr`: VPS public IP or hostname.
- `defaultServer`: server id from `data/servers.json`.
- `localMinecraftPortBase`: local backend ports assigned in `server.properties`.
- `minecraftRemotePortBase`: keep `26000` unless you need a different private range on the VPS.

Assign local backend ports:

```bash
node infra/hosting/scripts/assign-local-server-ports.js
```

Generate:

```bash
node infra/hosting/scripts/generate-hosting-configs.js
```

Outputs go to `infra/hosting/generated/`:

- `frps.toml`: VPS frp server.
- `frpc.toml`: home frp client.
- `velocity.toml`: VPS Minecraft hostname router.
- `Caddyfile`: VPS HTTPS reverse proxy for the admin GUI.
- `DNS.md`: DNS checklist.
- `routes.json`: generated server hostname and tunnel-port map.

## VPS Setup

Install:

```bash
sudo apt-get update
sudo apt-get install -y caddy openjdk-25-jre-headless
```

Install frp from its release package, then copy:

```bash
sudo mkdir -p /etc/frp /opt/velocity
sudo cp infra/hosting/generated/frps.toml /etc/frp/frps.toml
sudo cp infra/hosting/generated/Caddyfile /etc/caddy/Caddyfile
sudo cp infra/hosting/generated/velocity.toml /opt/velocity/velocity.toml
```

Download Velocity to:

```text
/opt/velocity/velocity.jar
```

Create a strong tunnel token:

```bash
openssl rand -base64 48
```

Put the same token in the VPS and home service environments as `FRP_TOKEN`.

Copy the systemd templates from `infra/hosting/systemd/vps/`, then:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now frps velocity caddy
```

Firewall on the VPS should allow only:

```text
22/tcp    SSH
80/tcp    HTTP
443/tcp   HTTPS
25565/tcp Minecraft
7000/tcp  frp tunnel control
```

## Home Game Host Setup

Copy:

```bash
sudo mkdir -p /etc/frp
sudo cp infra/hosting/generated/frpc.toml /etc/frp/frpc.toml
```

Install frp client and copy `infra/hosting/systemd/home/frpc.service`.

Run the dashboard. To try it:

```bash
npm start
```

To keep it running, install it as a service: see "Running it as a service" in the
[README](../../README.md#running-it-as-a-service). It listens on `127.0.0.1:4300`
by default, which is where the tunnel expects it.

Then start the tunnel:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now frpc
```

## Minecraft Server Settings

For this edge-proxy design, the backends should not authenticate directly with Mojang because Velocity is the public login point:

```properties
online-mode=false
```

The backend ports may be anything local. The generated `frpc.toml` reads each server's current `server-port`.

If multiple local servers run at once, each one still needs a unique local `server-port`. Players never need to know those ports.

## Security Notes

- Keep `FRP_TOKEN` private.
- Do not expose frp proxy ports publicly; `frps.toml` uses `proxyBindAddr = "127.0.0.1"` so Caddy and Velocity are the only public entry points.
- Do not port-forward the Minecraft backend ports on your router.
- Keep the admin dashboard protected with strong owner/admin passwords and server passphrases.
- The dashboard limits failed logins per visitor address, which in this layout it reads from `X-Forwarded-For` as Caddy sets it. The generated `Caddyfile` also removes any `CF-Connecting-IP` header a visitor sends, since nothing here is Cloudflare. If you wrote your `Caddyfile` by hand or generated it before this was added, regenerate it or add `header_up -CF-Connecting-IP` inside `reverse_proxy`.
- If you later move Paper/Purpur backends behind Velocity, switch to Velocity modern forwarding and configure the Paper forwarding secret.

## Sources

- Porkbun wildcard DNS: https://kb.porkbun.com/article/94-what-is-a-wildcard-dns-record
- Porkbun DNS API supports `A`, `AAAA`, `SRV`, and wildcard `*` records: https://porkbun.com/api/json/v3/documentation
- frp TCP proxies and `remotePort`: https://gofrp.org/en/docs/features/tcp-udp/
- frp `proxyBindAddr`: https://gofrp.org/en/docs/reference/server-configures/
- Caddy `reverse_proxy`: https://caddyserver.com/docs/caddyfile/directives/reverse_proxy
- Velocity `servers` and `forced-hosts`: https://docs.papermc.io/velocity/configuration/
- Velocity forwarding modes: https://docs.papermc.io/velocity/player-information-forwarding/
