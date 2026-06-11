//! Workspace service proxy host routing for rockyd.
//!
//! Port of the host-classification + route-registry half of
//! `core/packages/server/src/server/service-proxy.ts`. The critical contract
//! is correct host classification: hosts in the workspace-service namespace
//! must never fall through to the daemon APIs (they 404 instead). See
//! [`registry::ServiceProxyRouteRegistry::classify`].
//!
//! Actual reverse-proxy byte forwarding (the `proxyHttpRequest` /
//! `proxyUpgradeRequest` halves of the TS module) is intentionally out of
//! scope for this phase.
// TODO(phase-6+): wire a hyper/reqwest client to forward HTTP + websocket
// upgrades to `ServiceProxyRoute` targets.

pub mod hostname;
pub mod registry;

pub use hostname::{
    build_local_service_hostname, build_public_service_hostname, build_service_proxy_label,
    cap_dns_label, hash_label, normalize_host_header, to_hostname_label, ServiceLabelInput,
    HASH_SUFFIX_LENGTH, MAX_DNS_LABEL_LENGTH,
};
pub use registry::{
    HostClassification, RegisterWorkspaceServiceInput, ServiceProxyRoute,
    ServiceProxyRouteCollisionError, ServiceProxyRouteEntry, ServiceProxyRouteRegistry,
};
