# Porkbun DNS records for rippermoonstash.com

Create these records in Porkbun DNS:

| Type | Host | Answer |
| --- | --- | --- |
| A | @ | YOUR_VPS_PUBLIC_IPV4 |
| A | * | YOUR_VPS_PUBLIC_IPV4 |

Optional if your VPS has IPv6:

| Type | Host | Answer |
| --- | --- | --- |
| AAAA | @ | YOUR_VPS_PUBLIC_IPV6 |
| AAAA | * | YOUR_VPS_PUBLIC_IPV6 |

The wildcard record makes every current and future server hostname resolve to the VPS:

- cultoftheripper.rippermoonstash.com
- absolutechads.rippermoonstash.com

Minecraft Java clients will connect to cultoftheripper.rippermoonstash.com on the default port 25565. Velocity on the VPS reads the requested hostname and routes the player to the matching backend tunnel.
