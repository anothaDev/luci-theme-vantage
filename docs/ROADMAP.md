# Roadmap

Ideas and planned work, roughly in priority order. Nothing here is
promised; issues and pull requests for any of it are welcome.

## Next

### Multiple access points (planned for 1.1)

Show the radios, SSIDs and clients of other OpenWrt access points on the
main dashboard, so a router without Wi-Fi still shows the whole network
(ideas from [#5](https://github.com/anothaDev/luci-theme-vantage/pull/5)
by @nhAsif and [#127](https://github.com/anothaDev/luci-theme-vantage/pull/127)
by @Vikk20). In the tree as the optional `luci-app-vantage-aps`, for
1.1: each access point is paired once, then the router reads it over SSH
with a key that can only run a read-only report, against the access
point's pinned host key (see the spec, "Other access points"). Still
open: access points without Dropbear; per-port traffic that a switch
chip forwards without the kernel counting it; the collector under a user
of its own instead of root; finding a moved access point over IPv6.

### WireGuard tile (planned for 1.1)

Each tunnel's peers with their name, the time since the last handshake
and their traffic, shown only where a tunnel exists, as the Wi-Fi tiles
need a radio
([#129](https://github.com/anothaDev/luci-theme-vantage/issues/129)). In
the tree for 1.1, from LuCI's own `luci.wireguard getWgInstances`
(`luci-proto-wireguard`), which is read-only and returns no private or
preshared keys: the plugin gets no new method and the dashboard's ACL no
new grant. It shows for a login that holds LuCI's WireGuard group; one
limited to the dashboard's read group does not get it (see the spec,
"WireGuard tile"). Still open: what the call costs a router with many
peers, or with peers configured by host name, which LuCI's plugin looks
up on every call.

### Search for clients, radios and networks (planned for 1.1)

In the tree for 1.1: on the dashboard the command palette (Ctrl+K) also
finds what the dashboard knows:

- clients by alias, resolved name, MAC or IP, opening the client's
  details (a named device that is offline too);
- radios by band, channel or name, opening the radio's details;
- Wi-Fi networks, opening the dashboard filtered to that network;
- interfaces, opening their LuCI page.

The theme keeps working without the app: while the palette opens it
asks the page with an event, the dashboard answers with its entries, and
the theme checks each one and draws it itself, as text (see the spec,
"Entity search"). Other pages can answer the same way later; none
does yet.

### Update notice (planned for 1.1)

An opt-in daily check for a newer release, shown as a small dot on the
gear ([#133](https://github.com/anothaDev/luci-theme-vantage/issues/133)).
In the tree, for 1.1: **Daily update check** under Appearance, off by
default and set per browser, never saved on the router. With it on the
browser asks the project's package list once a day while a Vantage page
is open and in view, which shows the list's host (GitHub Pages) the
admin's IP address. The manual "Check for updates" stays, and updating
stays with the package manager: no update button (see the spec,
"Updates").

## Later

- **Proxies in the network path:** a full-tunnel VPN already shows on its
  line; name known proxy suites (OpenClash,
  PassWall, Mihomo, sing-box) with their running state, from a small
  table of service names. Needs one read-only ACL addition (the list of
  running services). Suite internals (nodes, rules) stay in their own
  pages for now; reading them would mean API secrets and HTTP calls from
  rpcd ([#7](https://github.com/anothaDev/luci-theme-vantage/issues/7)).
- **One-click actions (v2):** restart a radio, disconnect or block a
  client, enable or disable an SSID. Each action gets its own narrow ACL
  group and a confirmation; the read-only dashboard stays the default.
- **Client names from DHCP:** a small service on the device that watches
  DHCP requests crossing the bridge and records the hostnames clients
  send. This is the only automatic name source that works on an access
  point that is not the DHCP server.
- **History and alerts:** an optional rpcd plugin that keeps a small ring
  buffer (signal, throughput, client counts) so charts survive a page
  reload, plus simple alerts (uplink down, client with weak signal for
  minutes).
- **Topology view:** gateway, access points and switches from LLDP and
  neighbour tables, not just the local path.
- **luci-app-statistics integration:** show collectd history in the
  dashboard when it is installed.
- **OpenWrt 24.10 Wi-Fi pages:** 1.0.8 ships signed 24.10 packages,
  tested on a router without Wi-Fi. Still to check: the Wi-Fi pages and the
  dashboard's radio and client tiles on a 24.10 router with a radio.
- **Firewall overview from the live ruleset:** read what fw4 actually
  loaded (`nft -j list ruleset`, through a read-only rpcd call) instead of
  predicting it from the config. It ends the "can't tell" cases and the
  1.0.7 known limit on sets that services define (`docs/SPEC.md`), and the
  page no longer has to follow fw4's matching rules. Plan: one new method on
  the `luci.vantage` rpcd plugin, read-only and without arguments, that
  returns a summary (zones, their devices, what is open), never the raw
  ruleset. First try loading fw4 in the plugin (`require("fw4")`), which
  spawns nothing; `nft -j` only if fw4's internals change too much between
  releases. The browser gets no `file exec`: the ACL adds that one method to
  the app's read section, beside the firewall config it already reads, and
  `test_acl_policy.js` checks it stays read-only and argument-free.
  Alternative since the Status → Firewall flow chart: it reads the live
  ruleset with the `nft --terse --json list ruleset` call LuCI's own page
  makes, under luci-mod-status's ACL, with no new rpcd method and no change
  to the app's ACL. The overview could do the same: an admin login has that
  grant; a user without it keeps today's config-only view. That relaxes
  `test_acl_policy.js` for this one call, and the app needs its own copy of
  the model (`vantage-theme/nftmodel.js`), since theme and app stay
  independent. Decide this before building the rpcd method.

## Upstream

- **LuCI core `L.env` on anonymous 404 pages:** LuCI's core `header.ut`
  prints the whole menu tree for visitors who are not logged in (see
  `SECURITY.md` and `docs/luci-contract.md`). A small patch to print only
  the fields `luci.js` uses would fix it for every theme.
