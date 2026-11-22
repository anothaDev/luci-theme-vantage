#
# Vantage traffic: an opt-in, experimental add-on to the Vantage dashboard
# (luci-app-vantage). The traffic of devices that share one of the
# router's ports (a switch or an access point behind it), which the
# dashboard cannot count per device otherwise, from the kernel's
# connection accounting: one read-only rpcd ucode plugin and its own ACL
# group (luci-app-vantage-traffic). No firewall rule, sysctl change,
# service or config file.
#
# This is free software, licensed under the GNU General Public License,
# version 3 or (at your option) any later version.
#

include $(TOPDIR)/rules.mk

PKG_NAME:=luci-app-vantage-traffic
PKG_VERSION:=1.1.1
PKG_RELEASE:=1
PKG_LICENSE:=GPL-3.0-or-later

LUCI_TITLE:=Vantage per-device traffic (experimental)
LUCI_DESCRIPTION:=Shows on the Vantage dashboard the traffic of devices \
	that share a port of the router, counted from the router's connection \
	tracking: traffic through the router, not between devices of one \
	network. Changes nothing on the router. Experimental.
# The plugin (luci.vantage-traffic) reads /proc/net/nf_conntrack and the
# accounting switch, both kmod-nf-conntrack's (accounting is on by
# default: net.netfilter.nf_conntrack_acct=1), the IPv4 and IPv6
# neighbour tables through rtnl, and the theme's Low-power router option
# through uci. kmod-nf-conntrack is not a dependency: on a device without
# it the answer says there is no table. luci-app-vantage pulls in the
# ucode modules already; they are listed because the plugin needs them.
LUCI_DEPENDS:=+luci-app-vantage +rpcd-mod-ucode +ucode-mod-fs +ucode-mod-rtnl +ucode-mod-uci
# the dashboard of this release or a newer one: an older one does not ask
LUCI_EXTRA_DEPENDS:=luci-app-vantage (>=$(PKG_VERSION))
LUCI_PKGARCH:=all
LUCI_MAINTAINER:=anothaDev <10740588+anothaDev@users.noreply.github.com>
LUCI_URL:=https://github.com/anothaDev/luci-theme-vantage

PKG_PO_VERSION:=$(PKG_VERSION)-r$(PKG_RELEASE)

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
