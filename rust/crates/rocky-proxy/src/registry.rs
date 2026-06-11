//! In-memory service-proxy route registry and host classification.
//!
//! Port of `ServiceProxyRouteRegistry` and the `classifyHost` /
//! `ServiceProxyRouteCollisionError` logic in
//! `core/packages/server/src/server/service-proxy.ts` (lines 356-700).
//!
//! The classification contract is load-bearing: hosts in the workspace-service
//! namespace must NEVER fall through to daemon APIs. They classify as
//! [`HostClassification::KnownServiceMiss`] (a 404) instead of
//! [`HostClassification::Daemon`].

use std::collections::{HashMap, HashSet};

use crate::hostname::{
    build_local_service_hostname, build_public_service_hostname, normalize_host_header,
    url_hostname, ServiceLabelInput,
};

/// A live workspace-service route target (`ServiceProxyRoute`,
/// service-proxy.ts:14-17).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServiceProxyRoute {
    pub hostname: String,
    pub port: u16,
}

/// A stored route plus its owning workspace/script identity
/// (`ServiceProxyRouteEntry`, service-proxy.ts:19-26).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServiceProxyRouteEntry {
    pub hostname: String,
    pub port: u16,
    pub workspace_id: String,
    pub project_slug: String,
    pub script_name: String,
    pub public_hostname: Option<String>,
    pub public_base_url: Option<String>,
}

/// Input to register a workspace service (`RegisterWorkspaceServiceInput`,
/// service-proxy.ts:56-59 extending 49-54).
#[derive(Debug, Clone)]
pub struct RegisterWorkspaceServiceInput {
    pub workspace_id: String,
    pub project_slug: String,
    pub branch_name: Option<String>,
    pub script_name: String,
    pub port: u16,
    pub public_base_url: Option<String>,
}

/// Result of classifying an incoming `Host` header
/// (`HostClassification`, service-proxy.ts:61-77).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HostClassification {
    /// A known workspace-service host with a live route: proxy to it.
    Registered { route: ServiceProxyRoute },
    /// A host in the service namespace but with no live route: 404, MUST NOT
    /// fall through to daemon APIs.
    KnownServiceMiss,
    /// Everything else: normal daemon handling.
    Daemon,
}

/// Raised when a different owner tries to claim an already-registered hostname
/// (`ServiceProxyRouteCollisionError`, service-proxy.ts:356-367).
#[derive(Debug, Clone, thiserror::Error)]
#[error(
    "Service proxy hostname collision for {hostname}: {existing_workspace_id}/{existing_script_name} already owns it"
)]
pub struct ServiceProxyRouteCollisionError {
    pub hostname: String,
    pub existing_workspace_id: String,
    pub existing_script_name: String,
    pub incoming_workspace_id: String,
    pub incoming_script_name: String,
}

/// `sameRouteOwner` (service-proxy.ts:352-354): owners match iff workspace and
/// script names are equal.
fn same_route_owner(left: &ServiceProxyRouteEntry, right: &ServiceProxyRouteEntry) -> bool {
    left.workspace_id == right.workspace_id && left.script_name == right.script_name
}

/// Registry of workspace-service routes keyed by normalized hostname.
#[derive(Debug, Default)]
pub struct ServiceProxyRouteRegistry {
    /// Canonical hostname -> entry.
    routes: HashMap<String, ServiceProxyRouteEntry>,
    /// Alias hostname (local + public, lowercased) -> canonical hostname.
    hostname_aliases: HashMap<String, String>,
    /// workspace id -> set of canonical hostnames it owns.
    workspace_hostnames: HashMap<String, HashSet<String>>,
    /// Public base hostnames configured at construction time.
    configured_public_base_hostnames: HashSet<String>,
    /// Live set of public base hostnames (configured + per-route).
    public_base_hostnames: HashSet<String>,
}

impl ServiceProxyRouteRegistry {
    /// Construct an empty registry (`constructor`, service-proxy.ts:375-381).
    pub fn new(public_base_url: Option<&str>) -> Self {
        let mut registry = Self::default();
        if let Some(url) = public_base_url {
            if !url.is_empty() {
                let host = url_hostname(url);
                registry.configured_public_base_hostnames.insert(host.clone());
                registry.public_base_hostnames.insert(host);
            }
        }
        registry
    }

    fn label_input<'a>(input: &'a RegisterWorkspaceServiceInput) -> ServiceLabelInput<'a> {
        ServiceLabelInput {
            project_slug: &input.project_slug,
            branch_name: input.branch_name.as_deref(),
            script_name: &input.script_name,
        }
    }

    /// Register a workspace service, building its local (and optional public)
    /// hostname. Port of `registerWorkspaceService` + `registerRoute`
    /// (service-proxy.ts:383-417).
    ///
    /// Returns `Err` on collision: a *different* owner already claims one of
    /// the hostnames. Re-registering with the same owner replaces the route.
    pub fn register(
        &mut self,
        input: RegisterWorkspaceServiceInput,
    ) -> Result<ServiceProxyRouteEntry, ServiceProxyRouteCollisionError> {
        let label = Self::label_input(&input);
        let local_hostname = build_local_service_hostname(&label);
        let public_hostname = input
            .public_base_url
            .as_deref()
            .map(|base| build_public_service_hostname(&label, base));

        let entry = ServiceProxyRouteEntry {
            hostname: local_hostname,
            port: input.port,
            workspace_id: input.workspace_id,
            project_slug: input.project_slug,
            script_name: input.script_name,
            public_hostname,
            public_base_url: input.public_base_url,
        };

        self.register_route(entry.clone())?;
        Ok(entry)
    }

    /// Port of `registerRoute` (service-proxy.ts:401-417).
    fn register_route(
        &mut self,
        entry: ServiceProxyRouteEntry,
    ) -> Result<(), ServiceProxyRouteCollisionError> {
        self.assert_can_register(&entry)?;

        // Replace an existing same-owner route on the canonical hostname.
        if self.routes.contains_key(&entry.hostname) {
            let canonical = entry.hostname.clone();
            self.unregister(&canonical);
        }

        let hostnames = Self::route_hostnames(&entry);
        let canonical = entry.hostname.clone();
        let workspace_id = entry.workspace_id.clone();
        let public_base_url = entry.public_base_url.clone();

        self.routes.insert(canonical.clone(), entry);
        for alias in hostnames {
            self.hostname_aliases.insert(alias, canonical.clone());
        }
        if let Some(base) = public_base_url {
            self.public_base_hostnames.insert(url_hostname(&base));
        }
        self.workspace_hostnames
            .entry(workspace_id)
            .or_default()
            .insert(canonical);
        Ok(())
    }

    /// Port of `removeRoute` (service-proxy.ts:464-478). Accepts any alias.
    pub fn unregister(&mut self, hostname: &str) {
        let normalized = normalize_host_header(hostname);
        let canonical = self
            .hostname_aliases
            .get(&normalized)
            .cloned()
            .unwrap_or(normalized);
        let Some(entry) = self.routes.remove(&canonical) else {
            return;
        };
        for alias in Self::route_hostnames(&entry) {
            self.hostname_aliases.remove(&alias);
        }
        if let Some(set) = self.workspace_hostnames.get_mut(&entry.workspace_id) {
            set.remove(&canonical);
            if set.is_empty() {
                self.workspace_hostnames.remove(&entry.workspace_id);
            }
        }
        self.rebuild_public_base_hostnames();
    }

    /// Port of `classifyHost` (service-proxy.ts:585-610). This is the critical
    /// contract: namespace hosts never fall through to the daemon.
    pub fn classify(&self, host: Option<&str>) -> HostClassification {
        let Some(host) = host else {
            return HostClassification::Daemon;
        };
        let hostname = normalize_host_header(host);

        if let Some(route) = self.route_by_hostname(&hostname) {
            return HostClassification::Registered {
                route: ServiceProxyRoute {
                    hostname: route.hostname.clone(),
                    port: route.port,
                },
            };
        }

        // `.localhost` whose first label contains "--" looks like a service host.
        if hostname.ends_with(".localhost") {
            if let Some(first_label) = hostname.split('.').next() {
                if first_label.contains("--") {
                    return HostClassification::KnownServiceMiss;
                }
            }
        }

        // Hosts under a known public base are in the service namespace too.
        for base in &self.public_base_hostnames {
            if &hostname == base || hostname.ends_with(&format!(".{base}")) {
                return HostClassification::KnownServiceMiss;
            }
        }

        HostClassification::Daemon
    }

    /// Convenience: resolve a host header directly to a route, if registered.
    /// Port of `findRoute` (service-proxy.ts:612-615).
    pub fn find_route(&self, host: &str) -> Option<ServiceProxyRoute> {
        match self.classify(Some(host)) {
            HostClassification::Registered { route } => Some(route),
            _ => None,
        }
    }

    /// Port of `listRoutes` (service-proxy.ts:622-624).
    pub fn list_routes(&self) -> Vec<ServiceProxyRouteEntry> {
        self.routes.values().cloned().collect()
    }

    /// Port of `getRouteEntry` (service-proxy.ts:617-620).
    pub fn get_route_entry(&self, hostname: &str) -> Option<ServiceProxyRouteEntry> {
        self.route_by_hostname(&normalize_host_header(hostname)).cloned()
    }

    /// Port of `assertCanRegister` (service-proxy.ts:639-654).
    fn assert_can_register(
        &self,
        entry: &ServiceProxyRouteEntry,
    ) -> Result<(), ServiceProxyRouteCollisionError> {
        for hostname in Self::route_hostnames(entry) {
            let canonical = self
                .hostname_aliases
                .get(&hostname)
                .cloned()
                .unwrap_or_else(|| hostname.clone());
            if let Some(existing) = self.routes.get(&canonical) {
                if !same_route_owner(existing, entry) {
                    return Err(ServiceProxyRouteCollisionError {
                        hostname,
                        existing_workspace_id: existing.workspace_id.clone(),
                        existing_script_name: existing.script_name.clone(),
                        incoming_workspace_id: entry.workspace_id.clone(),
                        incoming_script_name: entry.script_name.clone(),
                    });
                }
            }
        }
        Ok(())
    }

    /// Port of `getRouteByHostname` (service-proxy.ts:670-673).
    fn route_by_hostname(&self, hostname: &str) -> Option<&ServiceProxyRouteEntry> {
        let canonical = self.hostname_aliases.get(hostname).map(String::as_str).unwrap_or(hostname);
        self.routes.get(canonical)
    }

    /// Port of `getRouteHostnames` (service-proxy.ts:675-681): local + public,
    /// lowercased.
    fn route_hostnames(entry: &ServiceProxyRouteEntry) -> Vec<String> {
        let mut hosts = vec![entry.hostname.to_lowercase()];
        if let Some(public) = &entry.public_hostname {
            hosts.push(public.to_lowercase());
        }
        hosts
    }

    /// Port of `rebuildPublicBaseHostnames` (service-proxy.ts:695-700).
    fn rebuild_public_base_hostnames(&mut self) {
        self.public_base_hostnames = self.configured_public_base_hostnames.clone();
        for entry in self.routes.values() {
            if let Some(base) = &entry.public_base_url {
                self.public_base_hostnames.insert(url_hostname(base));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reg_input(workspace: &str, script: &str) -> RegisterWorkspaceServiceInput {
        RegisterWorkspaceServiceInput {
            workspace_id: workspace.to_string(),
            project_slug: "my-project".to_string(),
            branch_name: Some("main".to_string()),
            script_name: script.to_string(),
            port: 4000,
            public_base_url: None,
        }
    }

    #[test]
    fn registered_host_classifies_as_registered() {
        let mut reg = ServiceProxyRouteRegistry::new(None);
        let entry = reg.register(reg_input("ws1", "web")).unwrap();
        assert_eq!(entry.hostname, "web--my-project.localhost");

        let c = reg.classify(Some("web--my-project.localhost:8080"));
        assert_eq!(
            c,
            HostClassification::Registered {
                route: ServiceProxyRoute {
                    hostname: "web--my-project.localhost".to_string(),
                    port: 4000,
                }
            }
        );
        assert_eq!(reg.list_routes().len(), 1);
        assert!(reg.find_route("web--my-project.localhost").is_some());
    }

    #[test]
    fn service_shaped_localhost_without_route_is_known_service_miss() {
        let reg = ServiceProxyRouteRegistry::new(None);
        // first label contains "--" and ends with .localhost -> namespace.
        assert_eq!(
            reg.classify(Some("api--other.localhost")),
            HostClassification::KnownServiceMiss
        );
        assert_eq!(
            reg.classify(Some("api--other.localhost:9999")),
            HostClassification::KnownServiceMiss
        );
    }

    #[test]
    fn plain_hosts_classify_as_daemon() {
        let reg = ServiceProxyRouteRegistry::new(None);
        assert_eq!(reg.classify(Some("localhost")), HostClassification::Daemon);
        assert_eq!(reg.classify(Some("localhost:3000")), HostClassification::Daemon);
        assert_eq!(reg.classify(Some("127.0.0.1:8080")), HostClassification::Daemon);
        assert_eq!(reg.classify(Some("example.com")), HostClassification::Daemon);
        // Plain (no "--") .localhost is daemon, not a service host.
        assert_eq!(reg.classify(Some("foo.localhost")), HostClassification::Daemon);
        assert_eq!(reg.classify(None), HostClassification::Daemon);
    }

    #[test]
    fn public_base_hosts_are_known_service_miss() {
        let reg = ServiceProxyRouteRegistry::new(Some("https://apps.example.com"));
        assert_eq!(
            reg.classify(Some("apps.example.com")),
            HostClassification::KnownServiceMiss
        );
        assert_eq!(
            reg.classify(Some("anything.apps.example.com")),
            HostClassification::KnownServiceMiss
        );
        assert_eq!(reg.classify(Some("example.com")), HostClassification::Daemon);
    }

    #[test]
    fn collision_on_register_errors() {
        let mut reg = ServiceProxyRouteRegistry::new(None);
        reg.register(reg_input("ws1", "web")).unwrap();
        // Different owner claiming the same hostname -> collision.
        let err = reg.register(reg_input("ws2", "web")).unwrap_err();
        assert_eq!(err.hostname, "web--my-project.localhost");
        assert_eq!(err.existing_workspace_id, "ws1");
        assert_eq!(err.incoming_workspace_id, "ws2");
    }

    #[test]
    fn same_owner_reregister_replaces() {
        let mut reg = ServiceProxyRouteRegistry::new(None);
        reg.register(reg_input("ws1", "web")).unwrap();
        let mut again = reg_input("ws1", "web");
        again.port = 5000;
        reg.register(again).unwrap();
        assert_eq!(reg.list_routes().len(), 1);
        assert_eq!(reg.get_route_entry("web--my-project.localhost").unwrap().port, 5000);
    }

    #[test]
    fn unregister_removes_route_and_aliases() {
        let mut reg = ServiceProxyRouteRegistry::new(None);
        let mut input = reg_input("ws1", "web");
        input.public_base_url = Some("https://apps.example.com".to_string());
        reg.register(input).unwrap();
        // public alias resolves.
        assert!(matches!(
            reg.classify(Some("web--my-project.apps.example.com")),
            HostClassification::Registered { .. }
        ));

        reg.unregister("web--my-project.localhost");
        assert_eq!(reg.list_routes().len(), 0);
        assert_eq!(reg.classify(Some("web--my-project.localhost")), HostClassification::KnownServiceMiss);
        // public base hostname removed from namespace after route gone.
        assert_eq!(reg.classify(Some("apps.example.com")), HostClassification::Daemon);
    }
}
