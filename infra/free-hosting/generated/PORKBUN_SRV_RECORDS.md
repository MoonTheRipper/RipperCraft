# Porkbun SRV records for Minecraft Java on rippermoonstash.com

Create one SRV record per server in Porkbun DNS.

| Server | Players type | Porkbun Type | Porkbun Host | Porkbun Answer/Value |
| --- | --- | --- | --- | --- |
| CultOfTheRipper | cultoftheripper.rippermoonstash.com | SRV | _minecraft._tcp.cultoftheripper | 1 1 8650 european-copyrighted.gl.at.ply.gg |
| AbsoluteChads | absolutechads.rippermoonstash.com | SRV | _minecraft._tcp.absolutechads | 1 1 8659 german-indirect.gl.at.ply.gg |

Notes:
- The Answer/Value format is: priority, weight, port, target.
- Do not add a port in Minecraft. Players type only the hostname.
- This is for Minecraft Java Edition. Bedrock does not use these SRV records.

